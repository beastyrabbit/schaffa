import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { TestContext } from "node:test";
import { CompactSign } from "jose";
import sharp from "sharp";
import { ClamGateScanner } from "../src/clamgate.js";
import { AppError } from "../src/errors.js";
import {
  app,
  assert,
  bootstrapToken,
  config,
  dataDir,
  db,
  multipart,
  multipartFields,
  path,
  processNextPendingScan,
  queueHtmlWithToken,
  readFile,
  test,
} from "./server-fixture.js";

const { scanUpload } = await import("../src/virus-scanner.js");

const pair = generateKeyPairSync("ed25519");
const options = {
  baseUrl: "https://scanner.example.test",
  publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  keyId: "fixture-key",
  applicationToken: "",
  timeoutMs: 2_000,
};

function scanner() {
  return new ClamGateScanner({ ...options, submissionIntervalMs: 0, retryDelayMs: 1 });
}

function fakeService(
  t: TestContext,
  settings: {
    outcome?: string;
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    wrongKey?: boolean;
    pollFailure?: boolean;
    postFailure?: boolean;
    afterUpload?: () => Promise<void>;
  } = {},
) {
  const requests: Array<{ method: string; url: string }> = [];
  const uploads: Buffer[] = [];
  const jobs = new Map<string, { nonce: string; bytes: Buffer; accessKey: string }>();
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const method = init.method || "GET";
    requests.push({ method, url: url.toString() });
    assert.equal(url.origin, options.baseUrl);
    assert.equal(init.redirect, "error");
    const headers = new Headers(init.headers);
    if (method === "POST") {
      if (settings.postFailure)
        throw new Error("Do not expose job credentials from transport errors");
      const chunks: Uint8Array[] = [];
      for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>)
        chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      uploads.push(bytes);
      const id = randomUUID();
      const accessKey = "x".repeat(43);
      jobs.set(id, { nonce: headers.get("X-Scan-Nonce") || "", bytes, accessKey });
      await settings.afterUpload?.();
      return Response.json({ id, accessKey }, { status: 202 });
    }
    const id = url.pathname.split("/").at(-1) || "";
    const job = jobs.get(id);
    assert.ok(job);
    assert.equal(headers.get("Authorization"), `Bearer ${job.accessKey}`);
    if (method === "DELETE") return Response.json({ accepted: true }, { status: 202 });
    polls += 1;
    if (settings.pollFailure && polls === 1)
      return new Response("temporarily unavailable", { status: 503 });
    const now = Math.floor(Date.now() / 1000);
    const outcome = settings.outcome || "clean";
    const result = await new CompactSign(
      Buffer.from(
        JSON.stringify({
          iss: "urn:clamgate:virus",
          jobId: id,
          nonce: job.nonce,
          sha256: createHash("sha256").update(job.bytes).digest("hex"),
          size: job.bytes.length,
          outcome,
          iat: now,
          exp: now + 3_600,
          policy: "clamgate-v1",
          engine: "ClamAV fixture",
          signatureVersion: "fixture",
          signatureDate: new Date().toISOString(),
          ...settings.claims,
        }),
      ),
    )
      .setProtectedHeader({
        alg: "EdDSA",
        typ: "clamgate-result+jws",
        kid: options.keyId,
        ...settings.header,
      })
      .sign(settings.wrongKey ? generateKeyPairSync("ed25519").privateKey : pair.privateKey);
    return Response.json({ id, state: outcome, result });
  });
  return { requests, uploads };
}

test("ClamGate streams bytes and verifies a signed result without resubmitting after poll failure", {}, async (t) => {
  const service = fakeService(t, { pollFailure: true });
  const bytes = Buffer.from("harmless fixture");
  assert.deepEqual(await scanner().scan(Readable.from([bytes])), {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
  assert.deepEqual(
    service.requests.map((request) => request.method),
    ["POST", "GET", "GET"],
  );
  assert.deepEqual(service.uploads, [bytes]);
});

for (const settings of [
  { wrongKey: true },
  { header: { kid: "unknown" } },
  { header: { typ: "JWT" } },
  { claims: { sha256: "0".repeat(64) } },
  { claims: { size: 900 } },
  { claims: { nonce: "other-request" } },
  { claims: { jobId: randomUUID() } },
  { claims: { iss: "untrusted" } },
  { claims: { policy: "unknown" } },
  { claims: { exp: 1 } },
  { claims: { iat: 9_999_999_999 } },
  { claims: { signatureDate: "2000-01-01T00:00:00Z" } },
  { claims: { outcome: "infected" } },
]) {
  test(`ClamGate keeps invalid signed results unavailable: ${JSON.stringify(settings)}`, {}, async (t) => {
    const service = fakeService(t, settings);
    await assert.rejects(scanner().scan(Readable.from([Buffer.from("fixture")])), {
      code: "scanner_unavailable",
    });
    assert.equal(service.requests.at(-1)?.method, "DELETE");
  });
}

for (const [outcome, code] of [
  ["infected", "malware_detected"],
  ["rejected", "scan_rejected"],
  ["failed", "scanner_unavailable"],
  ["cancelled", "scanner_unavailable"],
] as const) {
  test(`ClamGate handles signed ${outcome} results`, {}, async (t) => {
    fakeService(t, { outcome });
    await assert.rejects(scanner().scan(Readable.from([Buffer.from("fixture")])), { code });
  });
}

test("ClamGate rejects insecure origins", () => {
  for (const baseUrl of [
    "http://scanner.example.test",
    "https://scanner.example.test/path",
    "https://user:pass@scanner.example.test",
    "https://scanner.example.test?token=value",
  ]) {
    assert.throws(() => new ClamGateScanner({ ...options, baseUrl }), /HTTPS/);
  }
});

test("ClamGate cooldown expires even when the worker checks every two seconds", {}, async (t) => {
  const service = fakeService(t, { postFailure: true });
  t.mock.timers.enable({ apis: ["Date"] });
  const client = new ClamGateScanner(options);
  const run = () => client.scan(Readable.from([Buffer.from("fixture")]));
  await assert.rejects(run(), { code: "scanner_unavailable" });
  for (let i = 0; i < 29; i += 1) {
    t.mock.timers.tick(2_000);
    await assert.rejects(run(), { code: "scanner_unavailable" });
  }
  assert.equal(service.requests.length, 1);
  t.mock.timers.tick(2_001);
  await assert.rejects(run(), { code: "scanner_unavailable" });
  assert.equal(service.requests.length, 2);
});

test("ClamGate cancels an accepted job when its deadline expires", {}, async (t) => {
  const service = fakeService(t, { pollFailure: true });
  const client = new ClamGateScanner({ ...options, timeoutMs: 20 });
  await assert.rejects(client.scan(Readable.from([Buffer.from("fixture")])), {
    code: "scanner_unavailable",
  });
  assert.equal(service.requests.at(-1)?.method, "DELETE");
});

test("ClamGate page publication waits for verification and refuses changed quarantine bytes", {}, async (t) => {
  config.clamgate = { ...options };
  let quarantine = "";
  fakeService(t, {
    afterUpload: async () => {
      await writeFile(quarantine, "changed after scan");
    },
  });
  const queued = await queueHtmlWithToken("clamgate-changed", "<h1>Original</h1>", bootstrapToken);
  assert.equal(queued.statusCode, 202);
  const row = db()
    .prepare("SELECT storage_path FROM page_versions WHERE scan_status = 'pending'")
    .get() as { storage_path: string };
  quarantine = path.join(dataDir, row.storage_path);
  assert.equal((await processNextPendingScan()).status, "pending");
  const response = await app.inject({
    url: new URL(queued.json().publicUrl).pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(response.statusCode, 202);
  assert.doesNotMatch(response.body, /changed after scan|<h1>Original/);
  // Remove this deliberately corrupted fixture from the shared queue.
  db()
    .prepare("UPDATE page_versions SET scan_status = 'rejected' WHERE storage_path = ?")
    .run(row.storage_path);
});

test("ClamGate publishes clean page bytes at the original URL", {}, async (t) => {
  config.clamgate = { ...options };
  fakeService(t);
  const html = "<h1>ClamGate approved fixture</h1>";
  const queued = await queueHtmlWithToken("clamgate-clean", html, bootstrapToken);
  assert.equal(queued.statusCode, 202);
  assert.equal((await processNextPendingScan()).status, "clean");
  const response = await app.inject({
    url: new URL(queued.json().publicUrl).pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, html);
});

test("ClamGate invalid signatures leave file bytes quarantined", {}, async (t) => {
  config.clamgate = { ...options };
  fakeService(t, { wrongKey: true });
  const body = multipart("file", "fixture.txt", "text/plain", "private fixture");
  const queued = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(queued.statusCode, 202);
  assert.equal((await processNextPendingScan()).status, "pending");
  const row = db()
    .prepare("SELECT storage_path, scan_status FROM files WHERE id = ?")
    .get(queued.json().id) as { storage_path: string; scan_status: string };
  assert.equal(row.scan_status, "pending");
  assert.equal(await readFile(path.join(dataDir, row.storage_path), "utf8"), "private fixture");
  const response = await app.inject({
    url: new URL(queued.json().publicUrl).pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(response.statusCode, 202);
  assert.doesNotMatch(response.body, /private fixture/);
  db().prepare("UPDATE files SET scan_status = 'rejected' WHERE id = ?").run(queued.json().id);
});

test("ClamGate uses the same scanner for guide buffers and never accepts an invalid result", {}, async (t) => {
  config.clamgate = { ...options };
  fakeService(t, { wrongKey: true });
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  await assert.rejects(
    scanUpload(image),
    (error: unknown) => error instanceof AppError && error.code === "scanner_unavailable",
  );
});

test("ClamGate scans both original and published WebP bytes for files and guide screenshots", {}, async (t) => {
  config.clamgate = { ...options };
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const service = fakeService(t, {
    afterUpload: async () => {
      t.mock.timers.tick(6_501);
    },
  });
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  const auth = { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` };
  const body = multipart("file", "fixture.png", "image/png", image);
  const queued = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      ...auth,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(queued.statusCode, 202);
  assert.equal((await processNextPendingScan()).status, "clean");
  const published = await app.inject({
    url: new URL(queued.json().publicUrl).pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(published.statusCode, 200);
  assert.deepEqual(service.uploads[0], image);
  assert.deepEqual(service.uploads[1], published.rawPayload);
  assert.equal((await sharp(published.rawPayload).metadata()).format, "webp");

  const guide = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: auth,
    payload: { title: "ClamGate guide" },
  });
  assert.equal(guide.statusCode, 201);
  const stepBody = multipartFields(
    { step: JSON.stringify({ title: "Screenshot", description: "Inspect the fixture." }) },
    "screenshot",
    "fixture.png",
    "image/png",
    image,
  );
  const step = await app.inject({
    method: "POST",
    url: `/api/guides/${guide.json().slug}/steps`,
    headers: {
      ...auth,
      "content-type": stepBody.contentType,
      "if-match": '"1"',
    },
    payload: stepBody.payload,
  });
  assert.equal(step.statusCode, 201, step.body);
  const screenshot = await app.inject({
    url: new URL(step.json().steps[0].screenshotUrl).pathname,
    headers: auth,
  });
  assert.equal(screenshot.statusCode, 200);
  assert.deepEqual(service.uploads[2], image);
  assert.deepEqual(service.uploads[3], screenshot.rawPayload);
});

test("ClamGate shutdown cancels accepted jobs promptly", {}, async (t) => {
  const service = fakeService(t, { pollFailure: true });
  const client = new ClamGateScanner(options);
  const pending = client.scan(Readable.from([Buffer.from("fixture")]));
  const rejected = assert.rejects(pending, { code: "scanner_unavailable" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  client.close();
  await rejected;
  assert.equal(service.requests.at(-1)?.method, "DELETE");
});

test("ClamGate startup validates origin, trusted key and configured upload limits", async () => {
  const keyFile = path.join(dataDir, "fixture-public.pem");
  await writeFile(keyFile, options.publicKey);
  const env = {
    PATH: process.env.PATH,
    CLAMGATE_BASE_URL: options.baseUrl,
    CLAMGATE_PUBLIC_KEY_FILE: keyFile,
    CLAMGATE_PUBLIC_KEY_ID: options.keyId,
  };
  const load = (override: Record<string, string>) =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", "await import('./src/config.ts')"],
      { env: { ...env, ...override }, stdio: "pipe" },
    );
  assert.doesNotThrow(() => load({}));
  assert.doesNotThrow(() => load({ CLAMGATE_BASE_URL: "" }));
  assert.doesNotThrow(() => load({ VIRUS_SCANNER: "clamav" }));
  for (const override of [
    { CLAMGATE_BASE_URL: "http://scanner.example.test" },
    { CLAMGATE_PUBLIC_KEY_FILE: "" },
    { CLAMGATE_PUBLIC_KEY_ID: "" },
    { MAX_FILE_BYTES: "2147483646" },
    { CLAMGATE_TIMEOUT_MS: "3600001" },
    { CLAMGATE_GUIDE_TIMEOUT_MS: "3600001" },
  ])
    assert.throws(() => load(override));
  await writeFile(keyFile, "invalid PEM");
  assert.throws(() => load({}));
  assert.throws(() => load({ VIRUS_SCANNER: "clamav" }));
});

test("background WebP scans use the remote deadline while guide buffers keep the request cap", {}, async (t) => {
  config.clamgate = { ...options, timeoutMs: 5_000 };
  config.guideScanTimeoutMs = 1_000;
  const deadlines: Array<number | undefined> = [];
  t.mock.method(
    ClamGateScanner.prototype,
    "scan",
    async (input: AsyncIterable<Uint8Array>, timeoutMs?: number) => {
      deadlines.push(timeoutMs);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of input) {
        hash.update(chunk);
        size += chunk.length;
      }
      return { sha256: hash.digest("hex"), size };
    },
  );
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  const body = multipart("file", "deadline.png", "image/png", image);
  const queued = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(queued.statusCode, 202);
  assert.equal((await processNextPendingScan()).status, "clean");
  await scanUpload(image);
  assert.deepEqual(deadlines, [undefined, 5_000, 1_000]);
});
