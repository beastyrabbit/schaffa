import {
  adminCookie,
  app,
  assert,
  bootstrapToken,
  config,
  dataDir,
  db,
  finishPendingScans,
  multipart,
  path,
  processNextPendingScan,
  publishHtml,
  queueHtmlWithToken,
  readFile,
  scannerState,
  stalledScannerSockets,
  test,
  waitForStalledScanner,
} from "./server-fixture.js";

test("keeps monotonic page versions isolated from stale scan workers", async () => {
  await publishHtml("scan-race", "<h1>Version one</h1>");
  const oldVersion = await queueHtmlWithToken(
    "scan-race",
    "<h1>Old version two</h1>",
    bootstrapToken,
  );
  assert.equal(oldVersion.statusCode, 202);

  scannerState.mode = "stall";
  const staleScan = processNextPendingScan();
  await waitForStalledScanner();
  const deleted = await app.inject({
    method: "POST",
    url: "/admin/pages/scan-race/versions/2/delete",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(deleted.statusCode, 302);

  const replacementHtml = "<h1>Replacement version three</h1>";
  const replacement = await queueHtmlWithToken("scan-race", replacementHtml, bootstrapToken);
  assert.equal(replacement.statusCode, 202);
  assert.equal(replacement.json().version, 3);
  assert.equal(
    (await app.inject({ url: "/p/scan-race/2", headers: { host: "schaffa.test" } })).statusCode,
    404,
  );
  const replacementRow = db()
    .prepare(
      `SELECT pv.storage_path, pv.scan_status
       FROM page_versions pv JOIN pages p ON p.id = pv.page_id
       WHERE p.slug = 'scan-race' AND pv.version = 3`,
    )
    .get() as unknown as { storage_path: string; scan_status: string };

  scannerState.mode = "ok";
  for (const socket of stalledScannerSockets) socket.end("stream: OK\0");
  stalledScannerSockets.clear();
  await assert.rejects(staleScan);
  const replacementStatus = db()
    .prepare("SELECT scan_status FROM page_versions WHERE storage_path = ?")
    .get(replacementRow.storage_path) as unknown as { scan_status: string };
  assert.equal(replacementStatus.scan_status, "pending");
  assert.equal(
    await readFile(path.join(dataDir, replacementRow.storage_path), "utf8"),
    replacementHtml,
  );

  await finishPendingScans();
  const published = await app.inject({
    method: "GET",
    url: "/p/scan-race",
    headers: { host: "schaffa.test" },
  });
  assert.equal(published.statusCode, 200);
  assert.equal(published.body, replacementHtml);
});

test("rejects anonymous files, updates, malware, and scanner failures", async () => {
  config.anonymousUploadsPerHour = 2;
  const fileBody = multipart("file", "anonymous.txt", "text/plain", "nope");
  const file = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: { host: "schaffa.test", "content-type": fileBody.contentType },
    payload: fileBody.payload,
  });
  assert.equal(file.statusCode, 401);

  const updateBody = multipart("html", "update.html", "text/html", "<h1>No update</h1>");
  const update = await app.inject({
    method: "PUT",
    url: "/api/pages/no-anonymous-update",
    headers: { host: "schaffa.test", "content-type": updateBody.contentType },
    payload: updateBody.payload,
  });
  assert.equal(update.statusCode, 401);

  scannerState.mode = "infected";
  const infectedBody = multipart("html", "infected.html", "text/html", "<h1>Scanner marker</h1>");
  const infected = await app.inject({
    method: "POST",
    url: "/api/pages",
    headers: { host: "schaffa.test", "content-type": infectedBody.contentType },
    payload: infectedBody.payload,
  });
  assert.equal(infected.statusCode, 202);
  assert.equal((await processNextPendingScan()).status, "rejected");
  const infectedPage = await app.inject({
    method: "GET",
    url: new URL(infected.json().publicUrl).pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(infectedPage.statusCode, 422);
  assert.match(infectedPage.body, /Eicar-Test-Signature/);
  assert.doesNotMatch(infectedPage.body, /stream:/);

  scannerState.mode = "unavailable";
  const unavailableBody = multipart("html", "retry.html", "text/html", "<h1>Retry later</h1>");
  const unavailable = await app.inject({
    method: "POST",
    url: "/api/pages",
    headers: { host: "schaffa.test", "content-type": unavailableBody.contentType },
    payload: unavailableBody.payload,
  });
  assert.equal(unavailable.statusCode, 202);
  assert.equal((await processNextPendingScan()).status, "pending");
  const unavailablePage = await app.inject({
    method: "GET",
    url: new URL(unavailable.json().publicUrl).pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(unavailablePage.statusCode, 202);
  scannerState.mode = "ok";
  await finishPendingScans();

  const limitedBody = multipart("html", "limited.html", "text/html", "<h1>Too many</h1>");
  const limited = await app.inject({
    method: "POST",
    url: "/api/pages",
    headers: { host: "schaffa.test", "content-type": limitedBody.contentType },
    payload: limitedBody.payload,
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error, "rate_limited");
});

test("rotates unavailable scan jobs instead of starving the queue", async () => {
  const first = await queueHtmlWithToken("scan-fair-one", "<h1>One</h1>", bootstrapToken);
  const second = await queueHtmlWithToken("scan-fair-two", "<h1>Two</h1>", bootstrapToken);
  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);

  scannerState.mode = "unavailable";
  assert.equal((await processNextPendingScan()).status, "pending");
  assert.equal((await processNextPendingScan()).status, "pending");
  const attempts = db()
    .prepare(
      `SELECT p.slug, pv.scan_attempted_at
       FROM page_versions pv JOIN pages p ON p.id = pv.page_id
       WHERE p.slug IN ('scan-fair-one', 'scan-fair-two')`,
    )
    .all() as unknown as Array<{ slug: string; scan_attempted_at: string | null }>;
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((row) => row.scan_attempted_at));

  scannerState.mode = "ok";
  await finishPendingScans();
});

test("scans authenticated pages and files", async () => {
  scannerState.mode = "infected";
  const page = await publishHtml("authenticated-malware", "<h1>Malware marker</h1>");
  assert.equal(page.statusCode, 202);
  const rejectedPage = await app.inject({
    method: "GET",
    url: new URL(page.json().publicUrl).pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(rejectedPage.statusCode, 422);
  assert.match(rejectedPage.body, /Eicar-Test-Signature/);

  const body = multipart("file", "payload.bin", "application/octet-stream", "malware marker");
  const file = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(file.statusCode, 202);
  assert.equal((await processNextPendingScan()).status, "rejected");
  const rejectedFile = await app.inject({
    method: "GET",
    url: new URL(file.json().publicUrl).pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(rejectedFile.statusCode, 422);
  assert.match(rejectedFile.body, /Eicar-Test-Signature/);
  const rejectedRow = db()
    .prepare("SELECT storage_path, bytes, scan_message FROM files WHERE id = ?")
    .get(file.json().id) as unknown as {
    storage_path: string;
    bytes: number;
    scan_message: string;
  };
  assert.equal(rejectedRow.bytes, 0);
  assert.match(rejectedRow.scan_message, /Eicar-Test-Signature/);
  await assert.rejects(readFile(path.join(dataDir, rejectedRow.storage_path)), {
    code: "ENOENT",
  });

  scannerState.mode = "error";
  const scannerErrorBody = multipart(
    "file",
    "too-large-for-scanner.bin",
    "application/octet-stream",
    "scanner limit marker",
  );
  const scannerError = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": scannerErrorBody.contentType,
    },
    payload: scannerErrorBody.payload,
  });
  assert.equal(scannerError.statusCode, 202);
  assert.equal((await processNextPendingScan()).status, "rejected");
  const scannerErrorPage = await app.inject({
    method: "GET",
    url: new URL(scannerError.json().publicUrl).pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(scannerErrorPage.statusCode, 422);
  assert.doesNotMatch(scannerErrorPage.body, /INSTREAM/);
  scannerState.mode = "ok";
});
