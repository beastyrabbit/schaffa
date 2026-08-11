import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "schaffa-test-"));
const bootstrapToken = `sfa_${"a".repeat(43)}`;
let scannerMode: "ok" | "infected" | "unavailable" = "ok";
const scanner = net.createServer((socket) => {
  const request: Buffer[] = [];
  socket.on("data", (chunk) =>
    request.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
  );
  socket.on("end", () => {
    if (scannerMode === "unavailable") return socket.destroy();
    const response =
      scannerMode === "infected" ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0";
    socket.end(response);
  });
});
await new Promise<void>((resolve, reject) => {
  scanner.once("error", reject);
  scanner.listen(0, "127.0.0.1", resolve);
});
const scannerAddress = scanner.address();
if (!scannerAddress || typeof scannerAddress === "string")
  throw new Error("Scanner did not start.");
process.env.SCHAFFA_DATA_DIR = dataDir;
process.env.SCHAFFA_TOKEN_PEPPER = "test-only-pepper-with-enough-entropy";
process.env.SCHAFFA_BOOTSTRAP_TOKEN = bootstrapToken;
process.env.SCHAFFA_BASE_URL = "https://schaffa.test";
process.env.CLAMAV_HOST = "127.0.0.1";
process.env.CLAMAV_PORT = String(scannerAddress.port);
process.env.CLAMAV_TIMEOUT_MS = "1000";
process.env.ANONYMOUS_UPLOADS_PER_HOUR = "3";
process.env.LOG_LEVEL = "silent";

const { buildServer } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { purgeRetainedAnonymousPages } = await import("../src/service.js");
const app = buildServer();

test.after(async () => {
  await app.close();
  await new Promise<void>((resolve, reject) =>
    scanner.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(dataDir, { recursive: true, force: true });
});

test("rejects unauthenticated writes and unexpected hosts", async () => {
  const body = multipart("html", "page.html", "text/html", "<h1>Hello</h1>");
  const unauthorized = await app.inject({
    method: "PUT",
    url: "/api/pages/hello",
    headers: { host: "schaffa.test", "content-type": body.contentType },
    payload: body.payload,
  });
  assert.equal(unauthorized.statusCode, 401);

  const wrongHost = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "unexpected.test" },
  });
  assert.equal(wrongHost.statusCode, 404);

  const spoofedForwardedHost = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "unexpected.test", "x-forwarded-host": "schaffa.test" },
  });
  assert.equal(spoofedForwardedHost.statusCode, 404);

  const missingPage = await app.inject({
    method: "GET",
    url: "/p/missing",
    headers: { host: "schaffa.test" },
  });
  assert.equal(missingPage.statusCode, 404);
  assert.match(missingPage.headers["content-type"] || "", /^text\/html/);
  assert.match(missingPage.body, /Seite nicht gefunden/);
});

test("publishes immutable page versions under a stable slug", async () => {
  const firstHtml = "<h1>Hello version one is deliberately longer</h1>";
  const secondHtml = "<h1>Hello v2</h1>";
  const first = await publishHtml("hello", firstHtml);
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().version, 1);
  assert.equal(first.json().publicUrl, "https://schaffa.test/p/hello");
  assert.equal(first.json().rawUrl, "https://schaffa.test/p/hello/raw");

  const second = await publishHtml("hello", secondHtml);
  assert.equal(second.statusCode, 200);
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
  assert.match(String(v1.headers["cache-control"]), /immutable/);

  const raw = await app.inject({
    method: "GET",
    url: "/p/hello/1/raw",
    headers: { host: "schaffa.test", "user-agent": "curl/8" },
  });
  assert.equal(raw.statusCode, 200);
  assert.equal(raw.body, firstHtml);
  assert.equal(raw.headers["x-schaffa-version"], "1");

  const listed = await app.inject({
    method: "GET",
    url: "/api/pages",
    headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
  });
  const hello = listed.json().pages.find((page: { slug: string }) => page.slug === "hello");
  assert.equal(hello.latest_bytes, Buffer.byteLength(secondHtml));
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
  assert.equal(created.statusCode, 201);
  assert.match(created.json().slug, /^[a-z2-7]{12}$/);
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
  assert.equal(created.statusCode, 201);
  const { slug, expiresAt, purgeAt } = created.json();
  assert.match(slug, /^[a-z2-7]{12}$/);
  assert.ok(expiresAt);
  assert.ok(purgeAt);
  assert.ok(
    new Date(`${purgeAt}Z`).getTime() - new Date(`${expiresAt}Z`).getTime() > 29 * 86_400_000,
  );

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

  const listed = await app.inject({
    method: "GET",
    url: "/api/pages",
    headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(
    listed.json().pages.some((page: { slug: string }) => page.slug === slug),
    false,
  );
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

test("rejects anonymous files, updates, malware, and scanner failures", async () => {
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

  scannerMode = "infected";
  const infectedBody = multipart("html", "infected.html", "text/html", "<h1>Scanner marker</h1>");
  const infected = await app.inject({
    method: "POST",
    url: "/api/pages",
    headers: { host: "schaffa.test", "content-type": infectedBody.contentType },
    payload: infectedBody.payload,
  });
  assert.equal(infected.statusCode, 422);
  assert.equal(infected.json().error, "malware_detected");

  scannerMode = "unavailable";
  const unavailableBody = multipart("html", "retry.html", "text/html", "<h1>Retry later</h1>");
  const unavailable = await app.inject({
    method: "POST",
    url: "/api/pages",
    headers: { host: "schaffa.test", "content-type": unavailableBody.contentType },
    payload: unavailableBody.payload,
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().error, "scanner_unavailable");
  scannerMode = "ok";

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

test("rejects active HTML content", async () => {
  const response = await publishHtml("unsafe", '<button onclick="alert(1)">Nope</button>');
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error, "unsafe_html");
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
  assert.equal(upload.statusCode, 201);
  const publicUrl = new URL(upload.json().publicUrl);
  assert.match(publicUrl.pathname, /^\/f\/[A-Za-z0-9_-]{22}\.txt$/);
  assert.doesNotMatch(upload.body, /hello\.txt/);

  const ranged = await app.inject({
    method: "GET",
    url: publicUrl.pathname,
    headers: { host: "schaffa.test", range: "bytes=1-3" },
  });
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.body, "bcd");
  assert.equal(ranged.headers["content-range"], "bytes 1-3/6");
});

test("downscales images, preserves alpha, and strips identifying metadata", async () => {
  const source = await sharp({
    create: {
      width: 4000,
      height: 1000,
      channels: 4,
      background: { r: 179, g: 55, b: 42, alpha: 0.4 },
    },
  })
    .withExif({ IFD0: { Copyright: "private-camera-owner" } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><private>home-location</private></x:xmpmeta>')
    .png()
    .toBuffer();
  const body = multipart("file", "private-holiday-name.png", "image/png", source);
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

  assert.equal(upload.statusCode, 201);
  assert.match(upload.json().filename, /^[A-Za-z0-9_-]{22}\.webp$/);
  assert.doesNotMatch(upload.body, /private-holiday-name/);
  assert.equal(upload.json().mediaType, "image/webp");

  const publicPath = new URL(upload.json().publicUrl).pathname;
  const download = await app.inject({
    method: "GET",
    url: publicPath,
    headers: { host: "schaffa.test" },
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "image/webp");

  const metadata = await sharp(download.rawPayload).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 2560);
  assert.equal(metadata.height, 640);
  assert.equal(metadata.hasAlpha, true);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.iptc, undefined);
  assert.equal(metadata.icc, undefined);

  const { data, info } = await sharp(download.rawPayload).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  assert.ok(info.channels === 4 && data[3] !== undefined && data[3] < 255);

  const original = await app.inject({
    method: "GET",
    url: `${publicPath}/original`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(original.statusCode, 404);
});

async function publishHtml(slug: string, html: string) {
  const body = multipart("html", "page.html", "text/html", html);
  return app.inject({
    method: "PUT",
    url: `/api/pages/${slug}`,
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
}

function multipart(field: string, filename: string, mediaType: string, content: string | Buffer) {
  const boundary = "----schaffa-test-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`,
    ),
    typeof content === "string" ? Buffer.from(content) : content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload };
}
