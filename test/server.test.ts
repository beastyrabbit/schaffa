import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "mumpitz-test-"));
const bootstrapToken = `mpt_${"a".repeat(43)}`;
process.env.MUMPITZ_DATA_DIR = dataDir;
process.env.MUMPITZ_TOKEN_PEPPER = "test-only-pepper-with-enough-entropy";
process.env.MUMPITZ_BOOTSTRAP_TOKEN = bootstrapToken;
process.env.MUMPITZ_BASE_URL = "https://mumpitz.test";
process.env.LOG_LEVEL = "silent";

const { buildServer } = await import("../src/server.js");
const app = buildServer();

test.after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("rejects unauthenticated writes and unexpected hosts", async () => {
  const body = multipart("html", "page.html", "text/html", "<h1>Hello</h1>");
  const unauthorized = await app.inject({
    method: "PUT",
    url: "/api/pages/hello",
    headers: { host: "mumpitz.test", "content-type": body.contentType },
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
    headers: { host: "unexpected.test", "x-forwarded-host": "mumpitz.test" },
  });
  assert.equal(spoofedForwardedHost.statusCode, 404);

  const missingPage = await app.inject({
    method: "GET",
    url: "/p/missing",
    headers: { host: "mumpitz.test" },
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
  assert.equal(first.json().publicUrl, "https://mumpitz.test/p/hello");
  assert.equal(first.json().rawUrl, "https://mumpitz.test/p/hello/raw");

  const second = await publishHtml("hello", secondHtml);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().version, 2);

  const latest = await app.inject({
    method: "GET",
    url: "/p/hello",
    headers: { host: "mumpitz.test" },
  });
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.body, secondHtml);
  assert.equal(latest.headers["x-mumpitz-version"], "2");
  assert.match(String(latest.headers["content-security-policy"]), /script-src 'none'/);
  assert.doesNotMatch(String(latest.headers["content-security-policy"]), /https:/);

  const v1 = await app.inject({
    method: "GET",
    url: "/p/hello/1",
    headers: { host: "mumpitz.test" },
  });
  assert.equal(v1.body, firstHtml);
  assert.match(String(v1.headers["cache-control"]), /immutable/);

  const raw = await app.inject({
    method: "GET",
    url: "/p/hello/1/raw",
    headers: { host: "mumpitz.test", "user-agent": "curl/8" },
  });
  assert.equal(raw.statusCode, 200);
  assert.equal(raw.body, firstHtml);
  assert.equal(raw.headers["x-mumpitz-version"], "1");

  const listed = await app.inject({
    method: "GET",
    url: "/api/pages",
    headers: { host: "mumpitz.test", authorization: `Bearer ${bootstrapToken}` },
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
      host: "mumpitz.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(created.statusCode, 201);
  assert.match(created.json().slug, /^[a-z2-7]{12}$/);
  assert.doesNotMatch(created.json().slug, /named|plan/);
  assert.equal(created.json().rawUrl, `https://mumpitz.test/p/${created.json().slug}/raw`);
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
      host: "mumpitz.test",
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
    headers: { host: "mumpitz.test", range: "bytes=1-3" },
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
      host: "mumpitz.test",
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
    headers: { host: "mumpitz.test" },
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
    headers: { host: "mumpitz.test" },
  });
  assert.equal(original.statusCode, 404);
});

async function publishHtml(slug: string, html: string) {
  const body = multipart("html", "page.html", "text/html", html);
  return app.inject({
    method: "PUT",
    url: `/api/pages/${slug}`,
    headers: {
      host: "mumpitz.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
}

function multipart(field: string, filename: string, mediaType: string, content: string | Buffer) {
  const boundary = "----mumpitz-test-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`,
    ),
    typeof content === "string" ? Buffer.from(content) : content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload };
}
