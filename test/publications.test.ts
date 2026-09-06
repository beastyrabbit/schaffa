import {
  adminCookie,
  app,
  assert,
  bootstrapToken,
  config,
  createToken,
  dataDir,
  db,
  finishPendingScans,
  multipart,
  path,
  publishHtml,
  publishHtmlWithToken,
  purgeRetainedAnonymousPages,
  readFile,
  rm,
  sharp,
  test,
} from "./server-fixture.js";

test("serves a minimal public landing page while keeping API discovery machine-readable", async () => {
  const landing = await app.inject({
    method: "GET",
    url: "/",
    headers: { host: "schaffa.test" },
  });
  assert.equal(landing.statusCode, 200);
  assert.match(landing.headers["content-type"] || "", /^text\/html/);
  assert.match(landing.body, /Turn finished work into a link/);
  assert.equal(landing.body.match(/href="\/account"/g)?.length, 1);
  assert.match(landing.body, /href="\/account">Sign in/);
  assert.match(landing.body, /href="\/skills">Skills/);
  assert.match(landing.body, /<html lang="en">/);
  assert.doesNotMatch(landing.body, /Publish anonymously|landing-principles|>01<|>02<|>03</);
  assert.match(landing.body, /href="\/api">API/);
  assert.match(landing.body, /npx schaffa upload \.\/mypage\.html/);
  assert.match(landing.body, /rel="icon" href="\/assets\/favicon-c\.svg"/);
  assert.match(landing.body, /rel="apple-touch-icon" href="\/assets\/favicon-180\.png"/);
  assert.match(landing.body, /rel="manifest" href="\/site\.webmanifest"/);
  assert.match(landing.body, /url\('\/assets\/landing-bg\.svg'\)/);
  assert.match(String(landing.headers["content-security-policy"]), /default-src 'none'/);
  assert.match(String(landing.headers["content-security-policy"]), /img-src 'self'/);
  assert.match(String(landing.headers["content-security-policy"]), /frame-ancestors 'none'/);

  const background = await app.inject({
    method: "GET",
    url: "/assets/landing-bg.svg",
    headers: { host: "schaffa.test" },
  });
  assert.equal(background.statusCode, 200);
  assert.match(background.headers["content-type"] || "", /^image\/svg\+xml/);
  assert.match(background.body, /Abstract stack of published pages/);

  const favicon = await app.inject({
    method: "GET",
    url: "/assets/favicon-c.svg",
    headers: { host: "schaffa.test" },
  });
  assert.equal(favicon.statusCode, 200);
  assert.match(favicon.headers["content-type"] || "", /^image\/svg\+xml/);

  for (const size of [16, 32, 180, 192, 512]) {
    const png = await app.inject({
      method: "GET",
      url: `/assets/favicon-${size}.png`,
      headers: { host: "schaffa.test" },
    });
    assert.equal(png.statusCode, 200);
    assert.match(png.headers["content-type"] || "", /^image\/png/);
    const metadata = await sharp(png.rawPayload).metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
  }

  const legacyFavicon = await app.inject({
    method: "GET",
    url: "/favicon.ico",
    headers: { host: "schaffa.test" },
  });
  assert.equal(legacyFavicon.statusCode, 200);
  assert.match(legacyFavicon.headers["content-type"] || "", /^image\/x-icon/);
  assert.equal(legacyFavicon.rawPayload.readUInt16LE(2), 1);
  assert.equal(legacyFavicon.rawPayload.readUInt16LE(4), 2);

  const manifest = await app.inject({
    method: "GET",
    url: "/site.webmanifest",
    headers: { host: "schaffa.test" },
  });
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.json().name, "Schaffa");
  assert.equal(manifest.json().icons.length, 2);

  const apiRedirect = await app.inject({
    method: "GET",
    url: "/api",
    headers: { host: "schaffa.test" },
  });
  assert.equal(apiRedirect.statusCode, 301);
  assert.equal(apiRedirect.headers.location, "/api/");

  const api = await app.inject({
    method: "GET",
    url: "/api/",
    headers: { host: "schaffa.test" },
  });
  assert.equal(api.statusCode, 200);
  assert.match(api.headers["content-type"] || "", /^text\/html/);
  assert.match(api.body, /Schaffa API Reference/);
  assert.match(api.body, /"url": "\/metadata\/openapi\.json"/);
  assert.match(api.body, /src="js\/scalar\.js"/);
  assert.match(api.body, /"favicon": "\/assets\/favicon-c\.svg"/);
  assert.match(api.body, /"showDeveloperTools": "localhost"/);
  assert.doesNotMatch(api.body, /https?:\/\/.*(?:jsdelivr|scalar\.com)/);
  assert.match(String(api.headers["content-security-policy"]), /connect-src 'self'/);
  assert.doesNotMatch(String(api.headers["content-security-policy"]), /unsafe-eval/);

  const scalarScript = await app.inject({
    method: "GET",
    url: "/api/js/scalar.js",
    headers: { host: "schaffa.test" },
  });
  assert.equal(scalarScript.statusCode, 200);
  assert.match(scalarScript.headers["content-type"] || "", /^application\/javascript/);
  assert.match(scalarScript.body, /@scalar\/api-reference/);

  const specification = await app.inject({
    method: "GET",
    url: "/metadata/openapi.json",
    headers: { host: "schaffa.test" },
  });
  assert.equal(specification.statusCode, 200);
  assert.match(specification.headers["content-type"] || "", /^application\/json/);
  assert.equal(specification.json().openapi, "3.1.0");
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(specification.json().info.version, packageJson.version);
  assert.equal(specification.json().servers[0].url, "https://schaffa.test");
  assert.ok(specification.json().paths["/api/pages"].post);
  assert.ok(specification.json().paths["/api/pages/{slug}"].put);
  assert.ok(specification.json().paths["/api/files"].post);
  assert.ok(specification.json().paths["/api/guides"].post);
  assert.ok(specification.json().paths["/api/guides/{slug}/steps"].post);
  assert.ok(specification.json().paths["/api/guides/{slug}/finish"].post);
  assert.equal(specification.json().paths["/api/guides/{slug}/publish"], undefined);
  assert.deepEqual(specification.json().components.schemas.Guide.properties.status.enum, [
    "recording",
    "published",
  ]);
  assert.equal(
    specification.json().paths["/api/guides"].post.requestBody.content["application/json"].schema
      .properties.targetUrl.format,
    "uri",
  );
  assert.equal(
    specification.json().tags.some((tag: { name: string }) => tag.name === "Administration"),
    false,
  );
  assert.deepEqual(
    specification.json().tags.map((tag: { name: string }) => tag.name),
    ["Pages", "Files", "Guides"],
  );
  assert.equal(specification.json().paths["/api/tokens"], undefined);
  assert.equal(specification.json().paths["/api/users"], undefined);
  assert.equal(specification.json().paths["/api/settings"], undefined);
  const pagePut = specification.json().paths["/api/pages/{slug}"].put;
  assert.ok(pagePut.responses["202"]);
  assert.ok(pagePut.responses["404"]);
  assert.ok(pagePut.responses["413"]);
  assert.ok(pagePut.responses["429"]);
  assert.ok(pagePut.responses["503"]);
  assert.ok(pagePut.parameters.some((parameter: { name: string }) => parameter.name === "title"));
  assert.deepEqual(specification.json().components.schemas.PagePublication.required, [
    "slug",
    "title",
    "kind",
    "version",
    "bytes",
    "sha256",
    "publicUrl",
    "versionUrl",
    "rawUrl",
    "versionRawUrl",
    "expiresAt",
    "purgeAt",
    "scanStatus",
    "statusUrl",
  ]);
  assert.ok(specification.json().components.schemas.FilePublication.required.includes("sha256"));
});

test("publishes immutable page versions under a stable slug", async () => {
  const firstHtml = "<h1>Hello version one is deliberately longer</h1>";
  const secondHtml = "<h1>Hello v2</h1>";
  const first = await publishHtml("hello", firstHtml);
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().version, 1);
  assert.equal(first.json().publicUrl, "https://schaffa.test/p/hello");
  assert.equal(first.json().rawUrl, "https://schaffa.test/p/hello/raw");

  const second = await publishHtml("hello", secondHtml);
  assert.equal(second.statusCode, 202);
  assert.equal(second.json().version, 2);

  const latest = await app.inject({
    method: "GET",
    url: "/p/hello",
    headers: { host: "schaffa.test" },
  });
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.body, secondHtml);
  assert.equal(latest.headers["x-schaffa-version"], "2");
  assert.match(String(latest.headers["content-security-policy"]), /script-src 'none'/);
  assert.doesNotMatch(String(latest.headers["content-security-policy"]), /https:/);

  const v1 = await app.inject({
    method: "GET",
    url: "/p/hello/1",
    headers: { host: "schaffa.test" },
  });
  assert.equal(v1.body, firstHtml);
  assert.equal(v1.headers["cache-control"], "public, max-age=300");

  const raw = await app.inject({
    method: "GET",
    url: "/p/hello/1/raw",
    headers: { host: "schaffa.test", "user-agent": "curl/8" },
  });
  assert.equal(raw.statusCode, 200);
  assert.equal(raw.body, firstHtml);
  assert.equal(raw.headers["x-schaffa-version"], "1");

  const admin = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.match(admin.body, /hello/);
  assert.match(admin.body, new RegExp(`${Buffer.byteLength(secondHtml)} B`));
});

test("retains a page title when an update omits it", async () => {
  const first = await publishHtmlWithToken(
    "titled-page",
    "<h1>Version one</h1>",
    bootstrapToken,
    "Release plan",
  );
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().title, "Release plan");

  const updated = await publishHtml("titled-page", "<h1>Version two</h1>");
  assert.equal(updated.statusCode, 202);
  assert.equal(updated.json().title, "Release plan");

  const longTitleBody = multipart("html", "long-title.html", "text/html", "<h1>Nope</h1>");
  const longTitle = await app.inject({
    method: "PUT",
    url: `/api/pages/long-title?title=${"x".repeat(161)}`,
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": longTitleBody.contentType,
    },
    payload: longTitleBody.payload,
  });
  assert.equal(longTitle.statusCode, 422);
  assert.equal(longTitle.json().error, "invalid_title");
});

test("rejects repeated page query parameters as a client error", async () => {
  const body = multipart("html", "query.html", "text/html", "<h1>Query</h1>");
  const response = await app.inject({
    method: "PUT",
    url: "/api/pages/repeated-query?title=one&title=two",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error, "invalid_query");
});

test("returns 404 when page metadata outlives its stored content", async () => {
  const created = await publishHtml("missing-page-content", "<h1>Temporary inconsistency</h1>");
  assert.equal(created.statusCode, 202);
  const row = db()
    .prepare(
      "SELECT storage_path FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE slug = ?)",
    )
    .get("missing-page-content") as unknown as { storage_path: string };
  await rm(path.join(dataDir, row.storage_path));

  const missing = await app.inject({
    method: "GET",
    url: "/p/missing-page-content",
    headers: { host: "schaffa.test" },
  });
  assert.equal(missing.statusCode, 404);
  db().prepare("DELETE FROM pages WHERE slug = ?").run("missing-page-content");
});

test("creates pages with non-semantic random slugs", async () => {
  const body = multipart("html", "named-plan.html", "text/html", "<h1>Named plan</h1>");
  const created = await app.inject({
    method: "POST",
    url: "/api/pages",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(created.statusCode, 202);
  await finishPendingScans();
  assert.match(created.json().slug, /^[a-z0-9]{16}$/);
  assert.doesNotMatch(created.json().slug, /named|plan/);
  assert.equal(created.json().rawUrl, `https://schaffa.test/p/${created.json().slug}/raw`);
});

test("keeps anonymous pages visible for one hour and stored for 30 days", async () => {
  const body = multipart("html", "temporary-plan.html", "text/html", "<h1>Temporary plan</h1>");
  const created = await app.inject({
    method: "POST",
    url: "/api/pages",
    headers: { host: "schaffa.test", "content-type": body.contentType },
    payload: body.payload,
  });
  assert.equal(created.statusCode, 202);
  const { slug, expiresAt, purgeAt } = created.json();
  assert.match(slug, /^[a-z0-9]{16}$/);
  assert.ok(expiresAt);
  assert.ok(purgeAt);
  assert.ok(
    new Date(`${purgeAt}Z`).getTime() - new Date(`${expiresAt}Z`).getTime() > 29 * 86_400_000,
  );

  const pending = await app.inject({
    method: "GET",
    url: `/p/${slug}`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(pending.statusCode, 202);
  assert.match(pending.body, /Virus scan in progress/);
  assert.match(pending.body, /http-equiv="refresh" content="2"/);
  assert.doesNotMatch(pending.body, /Temporary plan/);
  assert.equal(pending.headers["cache-control"], "no-store");
  const pendingStatus = await app.inject({
    method: "GET",
    url: `/p/${slug}/status`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(pendingStatus.statusCode, 202);
  assert.equal(pendingStatus.json().scanStatus, "pending");
  const metrics = await app.inject({ method: "GET", url: "/metrics" });
  assert.match(metrics.body, /schaffa_pending_scans 1/);

  await finishPendingScans();
  const visible = await app.inject({
    method: "GET",
    url: `/p/${slug}`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(visible.statusCode, 200);
  assert.equal(visible.headers["cache-control"], "no-store");

  const visibleVersion = await app.inject({
    method: "GET",
    url: `/p/${slug}/1`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(visibleVersion.headers["cache-control"], "no-store");

  db()
    .prepare("UPDATE pages SET expires_at = datetime('now', '-1 second') WHERE slug = ?")
    .run(slug);
  const hidden = await app.inject({
    method: "GET",
    url: `/p/${slug}`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(hidden.statusCode, 404);

  assert.ok(db().prepare("SELECT 1 FROM pages WHERE slug = ?").get(slug));

  const admin = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: `__Secure-schaffa_admin=${bootstrapToken}` },
  });
  assert.equal(admin.statusCode, 200);
  assert.doesNotMatch(admin.body, new RegExp(slug));

  assert.equal(await purgeRetainedAnonymousPages(), 0);
  db().prepare("UPDATE pages SET purge_at = datetime('now', '-1 second') WHERE slug = ?").run(slug);
  assert.equal(await purgeRetainedAnonymousPages(), 1);
  assert.equal(db().prepare("SELECT 1 FROM pages WHERE slug = ?").get(slug), undefined);
});

test("uploads files under neutral 128-bit IDs and supports byte ranges", async () => {
  const body = multipart("file", "hello.txt", "text/plain", "abcdef");
  const upload = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(upload.statusCode, 202);
  const publicUrl = new URL(upload.json().publicUrl);
  assert.match(publicUrl.pathname, /^\/f\/[A-Za-z0-9_-]{22}\.txt$/);
  assert.doesNotMatch(upload.body, /hello\.txt/);
  const pending = await app.inject({
    method: "GET",
    url: publicUrl.pathname,
    headers: { host: "schaffa.test", range: "bytes=0-5" },
  });
  assert.equal(pending.statusCode, 202);
  assert.doesNotMatch(pending.body, /abcdef/);
  const pendingStatus = await app.inject({
    method: "GET",
    url: `${publicUrl.pathname}/status`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(pendingStatus.statusCode, 202);
  assert.equal(pendingStatus.json().scanStatus, "pending");
  await finishPendingScans();

  const ranged = await app.inject({
    method: "GET",
    url: publicUrl.pathname,
    headers: { host: "schaffa.test", range: "bytes=1-3" },
  });
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.body, "bcd");
  assert.equal(ranged.headers["content-range"], "bytes 1-3/6");
  assert.equal(ranged.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.match(String(ranged.headers["strict-transport-security"]), /max-age=31536000/);

  const suffix = await app.inject({
    method: "GET",
    url: publicUrl.pathname,
    headers: { host: "schaffa.test", range: "bytes=-3" },
  });
  assert.equal(suffix.statusCode, 206);
  assert.equal(suffix.body, "def");
  assert.equal(suffix.headers["content-range"], "bytes 3-5/6");

  const oversizedEnd = await app.inject({
    method: "GET",
    url: publicUrl.pathname,
    headers: { host: "schaffa.test", range: "bytes=4-99" },
  });
  assert.equal(oversizedEnd.statusCode, 206);
  assert.equal(oversizedEnd.body, "ef");
  assert.equal(oversizedEnd.headers["content-range"], "bytes 4-5/6");

  const hugeEnd = await app.inject({
    method: "GET",
    url: publicUrl.pathname,
    headers: { host: "schaffa.test", range: `bytes=4-${"9".repeat(30)}` },
  });
  assert.equal(hugeEnd.statusCode, 206);
  assert.equal(hugeEnd.body, "ef");

  const hugeSuffix = await app.inject({
    method: "GET",
    url: publicUrl.pathname,
    headers: { host: "schaffa.test", range: `bytes=-${"9".repeat(30)}` },
  });
  assert.equal(hugeSuffix.statusCode, 206);
  assert.equal(hugeSuffix.body, "abcdef");

  const multiple = await app.inject({
    method: "GET",
    url: publicUrl.pathname,
    headers: { host: "schaffa.test", range: "bytes=0-1,4-5" },
  });
  assert.equal(multiple.statusCode, 200);
  assert.equal(multiple.body, "abcdef");

  const invalid = await app.inject({
    method: "GET",
    url: publicUrl.pathname,
    headers: { host: "schaffa.test", range: "bytes=99-" },
  });
  assert.equal(invalid.statusCode, 416);
  assert.equal(invalid.headers["content-range"], "bytes */6");

  const row = db()
    .prepare("SELECT storage_path FROM files WHERE filename = ?")
    .get(publicUrl.pathname.slice("/f/".length)) as unknown as { storage_path: string };
  await rm(path.join(dataDir, row.storage_path));
  const missing = await app.inject({
    method: "GET",
    url: publicUrl.pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, "not_found");
});

test("enforces page ownership and prunes versions beyond the configured cap", async () => {
  const owner = createToken("owner");
  const other = createToken("other");
  const first = await publishHtmlWithToken("owned-page", "<h1>Owner version one</h1>", owner.token);
  assert.equal(first.statusCode, 202);

  const denied = await publishHtmlWithToken("owned-page", "<h1>Defaced</h1>", other.token);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, "forbidden");

  assert.equal((await publishHtml("owned-page", "<h1>Admin version two</h1>")).statusCode, 202);
  assert.equal((await publishHtml("owned-page", "<h1>Admin version three</h1>")).statusCode, 202);
  const pruned = await app.inject({
    method: "GET",
    url: "/p/owned-page/1",
    headers: { host: "schaffa.test" },
  });
  assert.equal(pruned.statusCode, 404);
  const versions = db()
    .prepare(
      "SELECT COUNT(*) AS count FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE slug = ?)",
    )
    .get("owned-page") as unknown as { count: number };
  assert.equal(versions.count, 2);
});

test("supports emergency page, version, and file takedown", async () => {
  await publishHtml("takedown-page", "<h1>Version one</h1>");
  await publishHtml("takedown-page", "<h1>Version two</h1>");
  const versionDelete = await app.inject({
    method: "POST",
    url: "/admin/pages/takedown-page/versions/1/delete",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(versionDelete.statusCode, 302);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/p/takedown-page/1",
        headers: { host: "schaffa.test" },
      })
    ).statusCode,
    404,
  );

  const pageDelete = await app.inject({
    method: "POST",
    url: "/admin/pages/takedown-page/delete",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(pageDelete.statusCode, 302);
  assert.equal(db().prepare("SELECT 1 FROM pages WHERE slug = 'takedown-page'").get(), undefined);

  const body = multipart("file", "remove.txt", "text/plain", "remove me");
  const upload = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  const fileDelete = await app.inject({
    method: "POST",
    url: `/admin/files/${upload.json().id}/delete`,
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(fileDelete.statusCode, 302);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: new URL(upload.json().publicUrl).pathname,
        headers: { host: "schaffa.test" },
      })
    ).statusCode,
    404,
  );
});

test("enforces a persistent per-token upload rate limit", async () => {
  const limited = createToken("rate-limited");
  for (let index = 0; index < config.authenticatedUploadsPerHour; index += 1) {
    const response = await publishHtmlWithToken(
      `rate-page-${index}`,
      `<h1>Rate page ${index}</h1>`,
      limited.token,
    );
    assert.equal(response.statusCode, 202);
  }
  const rejected = await publishHtmlWithToken("rate-page-over", "<h1>Over</h1>", limited.token);
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.json().error, "rate_limited");
});

test("enforces the global storage quota and removes rejected uploads", async () => {
  const quotaToken = createToken("quota");
  const firstBody = multipart(
    "file",
    "large.bin",
    "application/octet-stream",
    Buffer.alloc(850 * 1024, 1),
  );
  const first = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${quotaToken.token}`,
      "content-type": firstBody.contentType,
    },
    payload: firstBody.payload,
  });
  assert.equal(first.statusCode, 202);

  const secondBody = multipart(
    "file",
    "overflow.bin",
    "application/octet-stream",
    Buffer.alloc(300 * 1024, 2),
  );
  const second = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${quotaToken.token}`,
      "content-type": secondBody.contentType,
    },
    payload: secondBody.payload,
  });
  assert.equal(second.statusCode, 507);
  assert.equal(second.json().error, "storage_quota");
  assert.equal(
    (
      db()
        .prepare("SELECT COUNT(*) AS count FROM files WHERE created_by_token_id = ?")
        .get(quotaToken.id) as unknown as { count: number }
    ).count,
    1,
  );
  await app.inject({
    method: "POST",
    url: `/admin/files/${first.json().id}/delete`,
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
});
