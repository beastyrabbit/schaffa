import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import sharp from "sharp";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "schaffa-test-"));
const legacyDb = new DatabaseSync(path.join(dataDir, "schaffa.sqlite"));
legacyDb.exec(`
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT, revoked_at TEXT
  ) STRICT;
  CREATE TABLE pages (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT,
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT, purge_at TEXT
  ) STRICT;
  CREATE TABLE page_versions (
    id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, storage_path TEXT NOT NULL, bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL, created_by_token_id TEXT NOT NULL REFERENCES tokens(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(page_id, version)
  ) STRICT;
  INSERT INTO tokens (id, name, token_hash, scopes)
  VALUES ('legacy-token', 'Legacy token', 'system:legacy', 'upload');
  INSERT INTO pages (id, slug, current_version)
  VALUES ('legacy-page-id', 'legacy-page', 1);
  INSERT INTO page_versions
    (id, page_id, version, storage_path, bytes, sha256, created_by_token_id)
  VALUES
    ('legacy-version-id', 'legacy-page-id', 1, 'pages/legacy-page/1.html', 1, '00', 'legacy-token');
`);
legacyDb.close();
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
process.env.AUTHENTICATED_UPLOADS_PER_HOUR = "20";
process.env.MAX_PAGE_VERSIONS = "2";
process.env.MAX_STORAGE_BYTES = String(1024 * 1024);
process.env.MAX_PUBLISHED_IMAGE_BYTES = String(256 * 1024);
process.env.LOG_LEVEL = "silent";

const { buildServer } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { createToken, seedBootstrapToken } = await import("../src/auth.js");
const { purgeRetainedAnonymousPages } = await import("../src/service.js");
const app = buildServer({
  verifyShooToken: async (idToken: string) => ({
    subject: idToken,
    email: `${idToken.slice(0, 16)}@example.test`,
    name: `User ${idToken.slice(-4)}`,
  }),
});

test.after(async () => {
  await app.close();
  await new Promise<void>((resolve, reject) =>
    scanner.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(dataDir, { recursive: true, force: true });
});

test("migrates legacy ownership and token schemas in place", () => {
  const page = db().prepare("SELECT owner_token_id FROM pages WHERE id = 'legacy-page-id'").get() as
    | { owner_token_id: string }
    | undefined;
  assert.equal(page?.owner_token_id, "legacy-token");
  const tokenColumns = db().prepare("PRAGMA table_info(tokens)").all() as unknown as Array<{
    name: string;
  }>;
  assert.ok(tokenColumns.some((column) => column.name === "user_id"));
  db().prepare("DELETE FROM pages WHERE id = 'legacy-page-id'").run();
  db().prepare("DELETE FROM tokens WHERE id = 'legacy-token'").run();
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
  assert.equal(v1.headers["cache-control"], "public, max-age=300");

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
  assert.equal(ranged.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.match(String(ranged.headers["strict-transport-security"]), /max-age=31536000/);
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

test("enforces page ownership and prunes versions beyond the configured cap", async () => {
  const owner = createToken("owner");
  const other = createToken("other");
  const first = await publishHtmlWithToken("owned-page", "<h1>Owner version one</h1>", owner.token);
  assert.equal(first.statusCode, 201);

  const denied = await publishHtmlWithToken("owned-page", "<h1>Defaced</h1>", other.token);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, "forbidden");

  assert.equal((await publishHtml("owned-page", "<h1>Admin version two</h1>")).statusCode, 200);
  assert.equal((await publishHtml("owned-page", "<h1>Admin version three</h1>")).statusCode, 200);
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

test("scans authenticated pages and files", async () => {
  scannerMode = "infected";
  const page = await publishHtml("authenticated-malware", "<h1>Malware marker</h1>");
  assert.equal(page.statusCode, 422);
  assert.equal(page.json().error, "malware_detected");

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
  assert.equal(file.statusCode, 422);
  assert.equal(file.json().error, "malware_detected");
  scannerMode = "ok";
});

test("supports emergency page, version, and file takedown", async () => {
  await publishHtml("takedown-page", "<h1>Version one</h1>");
  await publishHtml("takedown-page", "<h1>Version two</h1>");
  const versionDelete = await app.inject({
    method: "DELETE",
    url: "/api/pages/takedown-page/versions/1",
    headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(versionDelete.statusCode, 204);
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
    method: "DELETE",
    url: "/api/pages/takedown-page",
    headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(pageDelete.statusCode, 204);
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
    method: "DELETE",
    url: `/api/files/${upload.json().id}`,
    headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(fileDelete.statusCode, 204);
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

test("write lockdown blocks publishing but leaves takedown available", async () => {
  const locked = await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": "application/json",
    },
    payload: { writesLocked: true },
  });
  assert.equal(locked.statusCode, 200);
  assert.equal(locked.json().writesLocked, true);
  const rejected = await publishHtml("locked-page", "<h1>Locked</h1>");
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.json().error, "writes_locked");
  await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": "application/json",
    },
    payload: { writesLocked: false },
  });
});

test("creates Shoo users and lets them manage their own agent tokens", async () => {
  const formLogin = await app.inject({
    method: "POST",
    url: "/auth/shoo",
    headers: { host: "schaffa.test", "content-type": "application/x-www-form-urlencoded" },
    payload: "idToken=login-csrf-attempt-1234567890",
  });
  assert.equal(formLogin.statusCode, 415);

  const loginPage = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test" },
  });
  assert.equal(loginPage.statusCode, 200);
  assert.match(loginPage.body, /shoo\.dev\/shoo\.js/);

  const login = await shooLogin("shoo-user-alpha-1234567890");
  assert.equal(login.statusCode, 200);
  const cookie = responseCookie(login, "__Secure-schaffa_user");
  const account = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test", cookie },
  });
  assert.equal(account.statusCode, 200);
  assert.match(account.body, /Agenten-Tokens/);

  const created = await app.inject({
    method: "POST",
    url: "/account/tokens",
    headers: {
      host: "schaffa.test",
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "name=my-agent",
  });
  assert.equal(created.statusCode, 200);
  const token = /sfa_[A-Za-z0-9_-]+/.exec(created.body)?.[0];
  assert.ok(token);
  const tokenRow = db()
    .prepare("SELECT * FROM tokens WHERE token_hash != '' AND name = ?")
    .get("my-agent") as unknown as { id: string; user_id: string; revoked_at: string | null };
  assert.ok(tokenRow.user_id);

  const revoked = await app.inject({
    method: "POST",
    url: `/account/tokens/${tokenRow.id}/revoke`,
    headers: { host: "schaffa.test", cookie },
  });
  assert.equal(revoked.statusCode, 302);
  assert.ok(
    (
      db().prepare("SELECT revoked_at FROM tokens WHERE id = ?").get(tokenRow.id) as unknown as {
        revoked_at: string | null;
      }
    ).revoked_at,
  );
});

test("admin controls Shoo signups and logins", async () => {
  await shooLogin("existing-shoo-user-1234567890");
  await updateSettings({ signupsEnabled: false });

  const rejectedSignup = await shooLogin("unknown-shoo-user-1234567890");
  assert.equal(rejectedSignup.statusCode, 403);
  assert.equal(rejectedSignup.json().error, "signups_disabled");
  assert.equal(
    db().prepare("SELECT 1 FROM users WHERE shoo_subject = ?").get("unknown-shoo-user-1234567890"),
    undefined,
  );

  const existing = await shooLogin("existing-shoo-user-1234567890");
  assert.equal(existing.statusCode, 200);
  const cookie = responseCookie(existing, "__Secure-schaffa_user");
  await updateSettings({ loginsEnabled: false });
  const rejectedLogin = await shooLogin("existing-shoo-user-1234567890");
  assert.equal(rejectedLogin.statusCode, 403);
  assert.equal(rejectedLogin.json().error, "logins_disabled");
  const expiredSession = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test", cookie },
  });
  assert.match(expiredSession.body, /Anmeldungen sind.+deaktiviert/);

  await updateSettings({ signupsEnabled: true, loginsEnabled: true });
});

test("admin deletion removes a Shoo user and revokes their tokens", async () => {
  const login = await shooLogin("deletable-shoo-user-1234567890");
  const cookie = responseCookie(login, "__Secure-schaffa_user");
  await app.inject({
    method: "POST",
    url: "/account/tokens",
    headers: {
      host: "schaffa.test",
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "name=delete-with-user",
  });
  const user = db()
    .prepare("SELECT id FROM users WHERE shoo_subject = ?")
    .get("deletable-shoo-user-1234567890") as unknown as { id: string };
  const ownedToken = db()
    .prepare("SELECT id FROM tokens WHERE name = 'delete-with-user'")
    .get() as unknown as { id: string };
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/users/${user.id}`,
    headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(removed.statusCode, 204);
  assert.equal(db().prepare("SELECT 1 FROM users WHERE id = ?").get(user.id), undefined);
  const token = db()
    .prepare("SELECT name, user_id, revoked_at FROM tokens WHERE id = ?")
    .get(ownedToken.id) as unknown as {
    name: string;
    user_id: string | null;
    revoked_at: string | null;
  };
  assert.equal(token.name, "Deleted user token");
  assert.equal(token.user_id, null);
  assert.ok(token.revoked_at);
  const oldSession = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test", cookie },
  });
  assert.match(oldSession.body, /Mit Google anmelden/);
});

test("enforces a persistent per-token upload rate limit", async () => {
  const limited = createToken("rate-limited");
  for (let index = 0; index < 20; index += 1) {
    const response = await publishHtmlWithToken(
      `rate-page-${index}`,
      `<h1>Rate page ${index}</h1>`,
      limited.token,
    );
    assert.equal(response.statusCode, 201);
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
  assert.equal(first.statusCode, 201);

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
    method: "DELETE",
    url: `/api/files/${first.json().id}`,
    headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
  });
});

test("bootstrap can be revoked after another admin exists and never resurrects", async () => {
  const replacement = createToken("replacement admin", ["admin"]);
  const revoked = await app.inject({
    method: "DELETE",
    url: "/api/tokens/bootstrap",
    headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(revoked.statusCode, 204);
  assert.deepEqual(seedBootstrapToken(), { active: false, created: false });

  const oldToken = await app.inject({
    method: "GET",
    url: "/api/tokens",
    headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(oldToken.statusCode, 401);
  const newToken = await app.inject({
    method: "GET",
    url: "/api/tokens",
    headers: { host: "schaffa.test", authorization: `Bearer ${replacement.token}` },
  });
  assert.equal(newToken.statusCode, 200);
});

test("rotating the bootstrap value reactivates it as the admin recovery path", async () => {
  const { config } = await import("../src/config.js");
  const rotatedToken = `sfa_${"b".repeat(43)}`;
  const original = config.bootstrapToken;
  config.bootstrapToken = rotatedToken;
  try {
    assert.deepEqual(seedBootstrapToken(), { active: true, created: false });
  } finally {
    config.bootstrapToken = original;
  }

  const oldToken = await app.inject({
    method: "GET",
    url: "/api/tokens",
    headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(oldToken.statusCode, 401);
  const rotated = await app.inject({
    method: "GET",
    url: "/api/tokens",
    headers: { host: "schaffa.test", authorization: `Bearer ${rotatedToken}` },
  });
  assert.equal(rotated.statusCode, 200);

  // Revoking again and re-seeding with the same rotated value must not resurrect it.
  db().prepare("UPDATE tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'bootstrap'").run();
  config.bootstrapToken = rotatedToken;
  try {
    assert.deepEqual(seedBootstrapToken(), { active: false, created: false });
  } finally {
    config.bootstrapToken = original;
  }
});

async function publishHtml(slug: string, html: string) {
  return publishHtmlWithToken(slug, html, bootstrapToken);
}

async function shooLogin(idToken: string) {
  return app.inject({
    method: "POST",
    url: "/auth/shoo",
    headers: { host: "schaffa.test", "content-type": "application/json" },
    payload: { idToken },
  });
}

async function updateSettings(settings: Record<string, boolean>) {
  const response = await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": "application/json",
    },
    payload: settings,
  });
  assert.equal(response.statusCode, 200);
  return response;
}

function responseCookie(
  response: { headers: Record<string, string | number | string[] | undefined> },
  name: string,
) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : String(header || "");
  const cookie = value?.split(";", 1)[0];
  assert.match(cookie || "", new RegExp(`^${name}=`));
  return cookie || "";
}

async function publishHtmlWithToken(slug: string, html: string, token: string) {
  const body = multipart("html", "page.html", "text/html", html);
  return app.inject({
    method: "PUT",
    url: `/api/pages/${slug}`,
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${token}`,
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
