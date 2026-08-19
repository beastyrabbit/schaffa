import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
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
  CREATE TABLE guides (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT,
    language TEXT NOT NULL DEFAULT 'de',
    status TEXT NOT NULL DEFAULT 'recording' CHECK(status IN ('recording','draft','published')),
    owner_token_id TEXT NOT NULL REFERENCES tokens(id),
    current_revision INTEGER NOT NULL DEFAULT 0, edit_revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;
  INSERT INTO tokens (id, name, token_hash, scopes)
  VALUES ('legacy-token', 'Legacy token', 'system:legacy', 'upload');
  INSERT INTO pages (id, slug, current_version)
  VALUES ('legacy-page-id', 'legacy-page', 1);
  INSERT INTO guides (id, slug, title, owner_token_id)
  VALUES ('legacy-guide-id', 'abc234def567', 'Legacy guide', 'legacy-token');
  INSERT INTO page_versions
    (id, page_id, version, storage_path, bytes, sha256, created_by_token_id)
  VALUES
    ('legacy-version-id', 'legacy-page-id', 1, 'pages/legacy-page/1.html', 1, '00', 'legacy-token');
`);
legacyDb.close();
const bootstrapToken = `sfa_${"a".repeat(43)}`;
let scannerMode: "ok" | "infected" | "unavailable" | "error" | "stall" = "ok";
const stalledScannerSockets = new Set<net.Socket>();
const scanner = net.createServer({ allowHalfOpen: true }, (socket) => {
  const request: Buffer[] = [];
  socket.on("data", (chunk) =>
    request.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
  );
  socket.on("end", () => {
    if (scannerMode === "unavailable") return socket.destroy();
    if (scannerMode === "stall") {
      stalledScannerSockets.add(socket);
      return;
    }
    const response =
      scannerMode === "infected"
        ? "stream: Eicar-Test-Signature FOUND\0"
        : scannerMode === "error"
          ? "stream: INSTREAM size limit exceeded. ERROR\0"
          : "stream: OK\0";
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
process.env.AUTHENTICATED_UPLOADS_PER_HOUR = "50";
process.env.MAX_PAGE_VERSIONS = "2";
process.env.MAX_STORAGE_BYTES = String(1024 * 1024);
process.env.MAX_PUBLISHED_IMAGE_BYTES = String(256 * 1024);
process.env.LOG_LEVEL = "silent";

const { buildServer } = await import("../src/server.js");
const { config } = await import("../src/config.js");
const { db } = await import("../src/db.js");
const { createToken, seedBootstrapToken } = await import("../src/auth.js");
const { allSkillsMarkdown, exampleSkills } = await import("../src/example-skills.js");
const { purgeRetainedAnonymousPages } = await import("../src/service.js");
const { pendingScanCount, processNextPendingScan } = await import("../src/scan-worker.js");
const app = buildServer({
  scanIntervalMs: 0,
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
  const pageColumns = db().prepare("PRAGMA table_info(pages)").all() as unknown as Array<{
    name: string;
  }>;
  assert.ok(pageColumns.some((column) => column.name === "kind"));
  const migratedVersion = db()
    .prepare("SELECT scan_status, scan_message FROM page_versions WHERE id = 'legacy-version-id'")
    .get() as unknown as { scan_status: string; scan_message: string | null };
  assert.equal(migratedVersion.scan_status, "clean");
  assert.equal(migratedVersion.scan_message, null);
  const userColumns = db().prepare("PRAGMA table_info(users)").all() as unknown as Array<{
    name: string;
  }>;
  assert.ok(userColumns.some((column) => column.name === "can_publish_interactive"));
  const guideColumns = db().prepare("PRAGMA table_info(guides)").all() as unknown as Array<{
    name: string;
  }>;
  assert.ok(guideColumns.some((column) => column.name === "target_url"));
  const guide = db().prepare("SELECT target_url FROM guides WHERE id = 'legacy-guide-id'").get() as
    | { target_url: string | null }
    | undefined;
  assert.equal(guide?.target_url, null);
  db().prepare("DELETE FROM pages WHERE id = 'legacy-page-id'").run();
  db().prepare("DELETE FROM guides WHERE id = 'legacy-guide-id'").run();
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

test("serves one general read skill and focused writing skills", async () => {
  assert.equal(exampleSkills.length, 5);
  const readSkill = exampleSkills.find((skill) => skill.slug === "read");
  const htmlSkill = exampleSkills.find((skill) => skill.slug === "html");
  const fileSkill = exampleSkills.find((skill) => skill.slug === "file");
  const guideSkill = exampleSkills.find((skill) => skill.slug === "guide");
  const presentationSkill = exampleSkills.find((skill) => skill.slug === "presentation");
  assert.ok(readSkill);
  assert.ok(htmlSkill);
  assert.ok(fileSkill);
  assert.ok(guideSkill);
  assert.ok(presentationSkill);
  assert.match(readSkill.markdown, /curl --fail --silent --show-error --location/);
  for (const route of ["/p/", "/f/", "/g/"]) assert.match(readSkill.markdown, new RegExp(route));
  assert.match(
    htmlSkill.markdown,
    /description: Use when the user asks to communicate through an HTML document, or if they mention "HTML" with no additional context\./,
  );
  assert.match(htmlSkill.markdown, /-F "html=@<html-file>;type=text\/html"/);
  assert.match(htmlSkill.markdown, /\$SCHAFFA_URL\/api\/pages/);
  assert.match(fileSkill.markdown, /-F "file=@<file>"/);
  assert.match(fileSkill.markdown, /\$SCHAFFA_URL\/api\/files/);
  assert.doesNotMatch(htmlSkill.markdown, /npx schaffa upload/);
  assert.doesNotMatch(fileSkill.markdown, /npx schaffa upload/);
  assert.match(guideSkill.markdown, /npx schaffa guide publish/);
  assert.match(presentationSkill.markdown, /npx schaffa publish/);

  const page = await app.inject({
    method: "GET",
    url: "/skills",
    headers: { host: "schaffa.test" },
  });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] || "", /^text\/html/);
  assert.match(page.body, /<html lang="en">/);
  assert.match(page.body, /general read skill/);
  assert.match(page.body, /curl --fail --silent --show-error --location/);
  assert.match(page.body, /href="\/skills\/all\.md"/);

  for (const skill of exampleSkills) {
    assert.ok(skill.markdown.trim().split("\n").length <= 40);
    assert.ok(skill.markdown.length < 2_500);
    assert.match(skill.markdown, /^---\nname: schaffa-/);
    assert.match(skill.markdown, /^---\nname: schaffa-[^\n]+\ndescription: Use when /);
    const description = skill.markdown.match(/^description: (.+)$/m)?.[1];
    assert.ok(description);
    assert.ok(description.length <= 140);
    assert.match(page.body, new RegExp(`href="/skills/${skill.slug}/SKILL\\.md"`));
    const raw = await app.inject({
      method: "GET",
      url: `/skills/${skill.slug}/SKILL.md`,
      headers: { host: "schaffa.test" },
    });
    assert.equal(raw.statusCode, 200);
    assert.match(raw.headers["content-type"] || "", /^text\/markdown/);
    assert.match(String(raw.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal(raw.body, `${skill.markdown}\n`);
  }

  const missing = await app.inject({
    method: "GET",
    url: "/skills/missing/SKILL.md",
    headers: { host: "schaffa.test" },
  });
  assert.equal(missing.statusCode, 404);

  const allSkills = await app.inject({
    method: "GET",
    url: "/skills/all.md",
    headers: { host: "schaffa.test" },
  });
  assert.equal(allSkills.statusCode, 200);
  assert.match(allSkills.headers["content-type"] || "", /^text\/markdown/);
  assert.match(String(allSkills.headers["content-security-policy"]), /default-src 'none'/);
  assert.equal(allSkills.body, allSkillsMarkdown());
  for (const skill of exampleSkills) assert.ok(allSkills.body.includes(skill.markdown));

  const llm = await app.inject({
    method: "GET",
    url: "/llm.txt",
    headers: { host: "schaffa.test" },
  });
  const llms = await app.inject({
    method: "GET",
    url: "/llms.txt",
    headers: { host: "schaffa.test" },
  });
  assert.equal(llm.statusCode, 200);
  assert.match(llm.headers["content-type"] || "", /^text\/plain/);
  assert.match(String(llm.headers["content-security-policy"]), /default-src 'none'/);
  assert.equal(llm.body, llms.body);
  assert.ok(llm.body.trim().split("\n").length <= 80);
  assert.match(llm.body, /\/p\/<slug>.*published HTML page/);
  assert.match(llm.body, /\/f\/<id>\.<ext>.*published file/);
  assert.match(llm.body, /\/g\/<slug>.*published step-by-step guide/);
  assert.match(llm.body, /All returned publication URLs are public/);
  assert.match(llm.body, /Writes require a bearer token/);
  assert.match(llm.body, /202 Accepted/);
  assert.match(llm.body, /https:\/\/schaffa\.test\/skills/);
  assert.match(llm.body, /https:\/\/schaffa\.test\/skills\/all\.md/);
  assert.match(llm.body, /https:\/\/schaffa\.test\/skills\/read\/SKILL\.md/);
  for (const slug of ["html", "file", "guide", "presentation"]) {
    assert.match(
      llm.body,
      new RegExp(`https:\\/\\/schaffa\\.test\\/skills\\/${slug}\\/SKILL\\.md`),
    );
  }
  assert.match(llm.body, /https:\/\/schaffa\.test\/metadata\/openapi\.json/);
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

test("keeps reused page versions isolated from stale scan workers", async () => {
  await publishHtml("scan-race", "<h1>Version one</h1>");
  const oldVersion = await queueHtmlWithToken(
    "scan-race",
    "<h1>Old version two</h1>",
    bootstrapToken,
  );
  assert.equal(oldVersion.statusCode, 202);

  scannerMode = "stall";
  const staleScan = processNextPendingScan();
  await waitForStalledScanner();
  const deleted = await app.inject({
    method: "POST",
    url: "/admin/pages/scan-race/versions/2/delete",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(deleted.statusCode, 302);

  const replacementHtml = "<h1>Replacement version two</h1>";
  const replacement = await queueHtmlWithToken("scan-race", replacementHtml, bootstrapToken);
  assert.equal(replacement.statusCode, 202);
  const replacementRow = db()
    .prepare(
      `SELECT pv.storage_path, pv.scan_status
       FROM page_versions pv JOIN pages p ON p.id = pv.page_id
       WHERE p.slug = 'scan-race' AND pv.version = 2`,
    )
    .get() as unknown as { storage_path: string; scan_status: string };

  scannerMode = "ok";
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

test("keeps legacy readable slugs but rejects new caller-chosen slugs", async () => {
  const created = await publishHtml("legacy-readable-page", "<h1>Existing page</h1>");
  assert.equal(created.statusCode, 202);
  const existing = await app.inject({
    method: "GET",
    url: "/p/legacy-readable-page",
    headers: { host: "schaffa.test" },
  });
  assert.equal(existing.statusCode, 200);
  assert.equal(existing.body, "<h1>Existing page</h1>");

  const body = multipart("html", "named.html", "text/html", "<h1>New named page</h1>");
  const rejected = await app.inject({
    method: "PUT",
    url: "/api/pages/new-readable-page",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(rejected.statusCode, 404);
  assert.equal(rejected.json().error, "not_found");
  assert.equal(
    db().prepare("SELECT 1 FROM pages WHERE slug = ?").get("new-readable-page"),
    undefined,
  );
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

test("records, edits, publishes, and revisions a guide incrementally", async () => {
  const owner = createToken("guide owner");
  const other = createToken("guide stranger");
  const auth = { host: "schaffa.test", authorization: `Bearer ${owner.token}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      title: "Projekt anlegen",
      description: "Ein belastbarer Beispielguide.",
      targetUrl: "https://app.example.com/projects?view=active&sort=name",
    },
  });
  assert.equal(created.statusCode, 201);
  assert.match(created.json().slug, /^[a-z2-7]{12}$/);
  assert.equal(created.json().status, "recording");
  assert.equal(created.json().editRevision, 1);
  assert.equal(created.json().targetUrl, "https://app.example.com/projects?view=active&sort=name");
  const slug = created.json().slug as string;

  const privateBeforePublish = await app.inject({
    method: "GET",
    url: `/g/${slug}`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(privateBeforePublish.statusCode, 404);

  const stepOne = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: {
      ...auth,
      "content-type": "application/json",
      "if-match": '"1"',
      "idempotency-key": "guide-step-one",
    },
    payload: {
      title: "Projekt öffnen",
      description: "Die Projektübersicht öffnen.",
      action: { type: "navigate", target: "/projects" },
      verification: "Die Projektliste ist sichtbar.",
      capture: false,
    },
  });
  assert.equal(stepOne.statusCode, 201);
  assert.equal(stepOne.json().steps.length, 1);
  assert.equal(stepOne.json().editRevision, 2);
  const firstStepId = stepOne.json().steps[0].id as string;

  const replay = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: {
      ...auth,
      "content-type": "application/json",
      "if-match": '"1"',
      "idempotency-key": "guide-step-one",
    },
    payload: { title: "would duplicate", description: "would duplicate" },
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.json().steps.length, 1);
  assert.equal(replay.json().steps[0].id, firstStepId);

  const screenshot = await sharp({
    create: { width: 3000, height: 2000, channels: 4, background: "#a43f24" },
  })
    .png()
    .toBuffer();
  const secondBody = multipartFields(
    {
      step: JSON.stringify({
        title: "Neu wählen",
        description: "New project auswählen.",
        action: { type: "click", target: "New project" },
        verification: "Das Formular ist sichtbar.",
        clickMarker: {
          x: 1500,
          y: 1000,
          viewportWidth: 3000,
          viewportHeight: 2000,
          box: { left: 1400, top: 900, width: 200, height: 200 },
        },
      }),
    },
    "screenshot",
    "capture.png",
    "image/png",
    screenshot,
  );
  const stepTwo = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": secondBody.contentType, "if-match": '"2"' },
    payload: secondBody.payload,
  });
  assert.equal(stepTwo.statusCode, 201);
  assert.equal(stepTwo.json().steps.length, 2);
  assert.match(stepTwo.json().steps[1].screenshotUrl, /\/g\/.*\/images\/.*\.webp$/);
  const secondStepId = stepTwo.json().steps[1].id as string;
  const imagePath = new URL(stepTwo.json().steps[1].screenshotUrl).pathname;

  const privateImage = await app.inject({
    method: "GET",
    url: imagePath,
    headers: { host: "schaffa.test" },
  });
  assert.equal(privateImage.statusCode, 404);
  const ownerImage = await app.inject({ method: "GET", url: imagePath, headers: auth });
  assert.equal(ownerImage.statusCode, 200);
  assert.equal((await sharp(ownerImage.rawPayload).metadata()).format, "webp");
  const marked = await sharp(ownerImage.rawPayload).raw().toBuffer({ resolveWithObject: true });
  assert.equal(Math.max(marked.info.width, marked.info.height), 2560);
  const markerX = Math.round(marked.info.width / 2);
  const markerY = Math.round(marked.info.height / 2);
  const markerOffset = (markerY * marked.info.width + markerX) * marked.info.channels;
  assert.ok((marked.data[markerOffset] ?? 0) > 180);
  assert.ok((marked.data[markerOffset + 1] ?? 255) < 130);
  assert.ok((marked.data[markerOffset + 2] ?? 255) < 150);

  const stale = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}/steps/${firstStepId}`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"2"' },
    payload: { title: "Stale" },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, "edit_conflict");

  const stranger = await app.inject({
    method: "GET",
    url: `/api/guides/${slug}`,
    headers: { host: "schaffa.test", authorization: `Bearer ${other.token}` },
  });
  assert.equal(stranger.statusCode, 403);

  const edited = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}/steps/${firstStepId}`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"3"' },
    payload: {
      title: "Projektübersicht öffnen",
      description: "Die aktuelle Projektübersicht öffnen.",
    },
  });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().editRevision, 4);
  const reordered = await app.inject({
    method: "PUT",
    url: `/api/guides/${slug}/order`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"4"' },
    payload: { order: [secondStepId, firstStepId] },
  });
  assert.equal(reordered.statusCode, 200);
  assert.equal(reordered.json().steps[0].id, secondStepId);

  const finished = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/finish`,
    headers: { ...auth, "if-match": '"5"' },
  });
  assert.equal(finished.statusCode, 200);
  assert.equal(finished.json().guide.status, "draft");
  assert.equal(finished.json().preflight.ready, true);

  const published = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/publish`,
    headers: { ...auth, "if-match": '"6"' },
  });
  assert.equal(published.statusCode, 201);
  assert.equal(published.json().guide.revision, 1);

  const publicGuide = await app.inject({
    method: "GET",
    url: `/g/${slug}`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(publicGuide.statusCode, 200);
  assert.match(publicGuide.body, /Projekt anlegen/);
  assert.match(publicGuide.body, /Projektübersicht öffnen/);
  assert.match(
    publicGuide.body,
    /class="target-link" href="https:\/\/app\.example\.com\/projects\?view=active&amp;sort=name"/,
  );
  assert.match(publicGuide.body, /Ziel öffnen/);
  assert.match(
    publicGuide.body,
    /class="step-action-link" href="https:\/\/app\.example\.com\/projects" target="_blank" rel="noopener noreferrer" aria-label="Seite öffnen \(neuer Tab\)">Seite öffnen/,
  );
  assert.doesNotMatch(publicGuide.body, /<code>navigate<\/code>/);
  assert.match(
    publicGuide.body,
    /class="screenshot-link" href="#image-1" aria-label="Screenshot zu Schritt 1 vergrößern"/,
  );
  assert.match(publicGuide.body, /class="zoom-hint"[^>]*>Bild vergrößern/);
  assert.match(publicGuide.body, /class="lightbox" id="image-1" role="dialog"/);
  assert.match(publicGuide.body, /target="_blank" rel="noopener noreferrer">Original öffnen/);
  assert.doesNotMatch(publicGuide.body, /<script|<form|onclick=/i);
  assert.match(String(publicGuide.headers["content-security-policy"]), /script-src 'none'/);
  const publicImage = await app.inject({
    method: "GET",
    url: imagePath,
    headers: { host: "schaffa.test" },
  });
  assert.equal(publicImage.statusCode, 200);

  const json = await app.inject({
    method: "GET",
    url: `/g/${slug}.json`,
    headers: { host: "schaffa.test" },
  });
  const markdown = await app.inject({
    method: "GET",
    url: `/g/${slug}.md`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(json.statusCode, 200);
  assert.equal(json.json().revision, 1);
  assert.equal(json.json().targetUrl, "https://app.example.com/projects?view=active&sort=name");
  assert.match(markdown.body, /# Projekt anlegen/);
  assert.match(
    markdown.body,
    /\[Ziel öffnen\]\(<https:\/\/app\.example\.com\/projects\?view=active&sort=name>\)/,
  );

  const newDraft = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}/steps/${firstStepId}`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"7"' },
    payload: { title: "Revision zwei" },
  });
  assert.equal(newDraft.statusCode, 200);
  assert.equal(newDraft.json().status, "draft");
  const immutableV1 = await app.inject({
    method: "GET",
    url: `/g/${slug}/1`,
    headers: { host: "schaffa.test" },
  });
  assert.doesNotMatch(immutableV1.body, /Revision zwei/);
});

test("accepts only safe web destinations for guides", async () => {
  const owner = createToken("guide URL owner");
  const headers = {
    host: "schaffa.test",
    authorization: `Bearer ${owner.token}`,
    "content-type": "application/json",
  };
  for (const targetUrl of [
    "javascript:alert(document.domain)",
    "https://user:password@app.example.com/projects",
    "/projects",
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/guides",
      headers,
      payload: { title: "Unsafe destination", targetUrl },
    });
    assert.equal(response.statusCode, 422);
  }
});

test("sets, clears, and limits a guide destination", async () => {
  const owner = createToken("guide destination owner");
  const headers = {
    host: "schaffa.test",
    authorization: `Bearer ${owner.token}`,
    "content-type": "application/json",
  };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers,
    payload: { title: "Destination edits" },
  });
  assert.equal(created.statusCode, 201);
  const slug = created.json().slug as string;

  const set = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}`,
    headers: { ...headers, "if-match": '"1"' },
    payload: { targetUrl: " https://app.example.com/projects " },
  });
  assert.equal(set.statusCode, 200);
  assert.equal(set.json().targetUrl, "https://app.example.com/projects");

  const clear = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}`,
    headers: { ...headers, "if-match": '"2"' },
    payload: { targetUrl: "" },
  });
  assert.equal(clear.statusCode, 200);
  assert.equal(clear.json().targetUrl, null);

  const normalizedOverlong = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}`,
    headers: { ...headers, "if-match": '"3"' },
    payload: { targetUrl: `https://example.com/${"é".repeat(990)}` },
  });
  assert.equal(normalizedOverlong.statusCode, 422);
});

test("rejects sensitive guide text during publication", async () => {
  const owner = createToken("sensitive guide owner");
  const auth = { host: "schaffa.test", authorization: `Bearer ${owner.token}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: { ...auth, "content-type": "application/json" },
    payload: { title: "Sensitive" },
  });
  const slug = created.json().slug;
  const step = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"1"' },
    payload: { title: "Login", description: "password=do-not-publish", capture: false },
  });
  assert.equal(step.statusCode, 201);
  const finished = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/finish`,
    headers: { ...auth, "if-match": '"2"' },
  });
  assert.equal(finished.json().preflight.ready, false);
  const published = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/publish`,
    headers: { ...auth, "if-match": '"3"' },
  });
  assert.equal(published.statusCode, 422);
  assert.equal(published.json().error, "preflight_failed");
});

test("keeps hidden-step screenshots private and maps multipart errors to 4xx", async () => {
  const owner = createToken("hidden screenshot owner");
  const auth = { host: "schaffa.test", authorization: `Bearer ${owner.token}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: { ...auth, "content-type": "application/json" },
    payload: { title: "Hidden screenshot" },
  });
  const slug = created.json().slug;
  const invalid = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded", "if-match": '"1"' },
    payload: "title=nope",
  });
  assert.ok(invalid.statusCode >= 400 && invalid.statusCode < 500);

  const screenshot = await sharp({
    create: { width: 80, height: 50, channels: 4, background: "#315a3a" },
  })
    .png()
    .toBuffer();
  const body = multipartFields(
    {
      step: JSON.stringify({
        title: "Hidden",
        description: "Not part of publication",
        visible: false,
      }),
    },
    "screenshot",
    "hidden.png",
    "image/png",
    screenshot,
  );
  const step = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": body.contentType, "if-match": '"1"' },
    payload: body.payload,
  });
  assert.equal(step.statusCode, 201);
  const hiddenPath = new URL(step.json().steps[0].screenshotUrl).pathname;
  const visible = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"2"' },
    payload: { title: "Visible", description: "Publishable text step", capture: false },
  });
  assert.equal(visible.statusCode, 201);
  await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/finish`,
    headers: { ...auth, "if-match": '"3"' },
  });
  const published = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/publish`,
    headers: { ...auth, "if-match": '"4"' },
  });
  assert.equal(published.statusCode, 201);
  const hidden = await app.inject({
    method: "GET",
    url: hiddenPath,
    headers: { host: "schaffa.test" },
  });
  assert.equal(hidden.statusCode, 404);
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

  scannerMode = "unavailable";
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
  scannerMode = "ok";
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

test("rejects active HTML content", async () => {
  const response = await publishHtml("unsafe", '<button onclick="alert(1)">Nope</button>');
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error, "unsafe_html");

  const template = await publishHtml(
    "unsafe-template",
    "<template><script>alert(1)</script></template>",
  );
  assert.equal(template.statusCode, 422);
  assert.equal(template.json().error, "unsafe_html");

  const obfuscatedUrl = await publishHtml("unsafe-url", '<a href="jav\nascript:alert(1)">Nope</a>');
  assert.equal(obfuscatedUrl.statusCode, 422);
  assert.equal(obfuscatedUrl.json().error, "unsafe_html");
});

test("rotates unavailable scan jobs instead of starving the queue", async () => {
  const first = await queueHtmlWithToken("scan-fair-one", "<h1>One</h1>", bootstrapToken);
  const second = await queueHtmlWithToken("scan-fair-two", "<h1>Two</h1>", bootstrapToken);
  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);

  scannerMode = "unavailable";
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

  scannerMode = "ok";
  await finishPendingScans();
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

  assert.equal(upload.statusCode, 202);
  await finishPendingScans();
  assert.match(upload.json().filename, /^[A-Za-z0-9_-]{22}\.webp$/);
  assert.doesNotMatch(upload.body, /private-holiday-name/);
  assert.equal(upload.json().mediaType, "image/webp");
  assert.equal(upload.json().bytes, null);
  assert.equal(upload.json().sha256, null);

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

test("scans authenticated pages and files", async () => {
  scannerMode = "infected";
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

  scannerMode = "error";
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
  scannerMode = "ok";
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

test("keeps administration out of the public API", async () => {
  for (const [method, url] of [
    ["GET", "/api/pages"],
    ["GET", "/api/files"],
    ["GET", "/api/tokens"],
    ["POST", "/api/tokens"],
    ["GET", "/api/users"],
    ["GET", "/api/settings"],
    ["PUT", "/api/settings"],
    ["DELETE", "/api/pages/example-page"],
    ["DELETE", "/api/files/aaaaaaaaaaaaaaaaaaaaaa"],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
    });
    assert.equal(response.statusCode, 404, `${method} ${url} must not be an admin API`);
  }

  const admin = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(admin.statusCode, 200);
  assert.match(admin.body, /Lockdown aktivieren/);
  assert.match(admin.body, /Registrierungen sperren/);
  assert.match(admin.body, /Anmeldungen sperren/);
  assert.match(admin.body, /Token erstellen/);
  assert.match(admin.body, /Versionen/);
});

test("write lockdown blocks publishing but leaves takedown available", async () => {
  const locked = await app.inject({
    method: "POST",
    url: "/admin/settings",
    headers: {
      host: "schaffa.test",
      cookie: adminCookie(bootstrapToken),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "writesLocked=true",
  });
  assert.equal(locked.statusCode, 302);
  const rejected = await publishHtml("locked-page", "<h1>Locked</h1>");
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.json().error, "writes_locked");
  await app.inject({
    method: "POST",
    url: "/admin/settings",
    headers: {
      host: "schaffa.test",
      cookie: adminCookie(bootstrapToken),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "writesLocked=false",
  });
});

test("creates Shoo users and lets them manage their own tokens and uploads", async () => {
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

  const page = await publishHtmlWithToken("account-owned-page", "<h1>Version one</h1>", token);
  assert.equal(page.statusCode, 202);
  const updatedPage = await publishHtmlWithToken(
    "account-owned-page",
    "<h1>Version two</h1>",
    token,
  );
  assert.equal(updatedPage.statusCode, 202);
  const fileBody = multipart("file", "account-note.txt", "text/plain", "account file");
  const file = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${token}`,
      "content-type": fileBody.contentType,
    },
    payload: fileBody.payload,
  });
  assert.equal(file.statusCode, 202);
  const fileId = file.json().id as string;

  const populatedAccount = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test", cookie },
  });
  assert.match(populatedAccount.body, /Dein Konto/);
  assert.match(populatedAccount.body, /account-owned-page/);
  assert.match(populatedAccount.body, new RegExp(fileId));
  assert.match(populatedAccount.body, /my-agent/);

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
  const accountAfterRevoke = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test", cookie },
  });
  assert.match(accountAfterRevoke.body, /account-owned-page/);
  assert.match(accountAfterRevoke.body, new RegExp(fileId));

  const otherLogin = await shooLogin("shoo-user-beta-1234567890");
  const otherCookie = responseCookie(otherLogin, "__Secure-schaffa_user");
  const deniedPageDelete = await app.inject({
    method: "POST",
    url: "/account/pages/account-owned-page/delete",
    headers: { host: "schaffa.test", cookie: otherCookie },
  });
  assert.equal(deniedPageDelete.statusCode, 404);
  const deniedFileDelete = await app.inject({
    method: "POST",
    url: `/account/files/${fileId}/delete`,
    headers: { host: "schaffa.test", cookie: otherCookie },
  });
  assert.equal(deniedFileDelete.statusCode, 404);

  const deletedVersion = await app.inject({
    method: "POST",
    url: "/account/pages/account-owned-page/versions/1/delete",
    headers: { host: "schaffa.test", cookie },
  });
  assert.equal(deletedVersion.statusCode, 302);
  const remainingVersions = db()
    .prepare(
      "SELECT COUNT(*) AS count FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE slug = ?)",
    )
    .get("account-owned-page") as unknown as { count: number };
  assert.equal(remainingVersions.count, 1);
  const deletedPage = await app.inject({
    method: "POST",
    url: "/account/pages/account-owned-page/delete",
    headers: { host: "schaffa.test", cookie },
  });
  assert.equal(deletedPage.statusCode, 302);
  const deletedFile = await app.inject({
    method: "POST",
    url: `/account/files/${fileId}/delete`,
    headers: { host: "schaffa.test", cookie },
  });
  assert.equal(deletedFile.statusCode, 302);
  assert.equal(
    db().prepare("SELECT 1 FROM pages WHERE slug = ?").get("account-owned-page"),
    undefined,
  );
  assert.equal(db().prepare("SELECT 1 FROM files WHERE id = ?").get(fileId), undefined);
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

test("allows only explicitly trusted users to publish sandboxed interactive pages", async () => {
  const interactiveHtml =
    "<!doctype html><h1>Interactive plan</h1><script>document.body.dataset.ready = 'yes'</script>";
  const disabledBody = multipart("html", "interactive.html", "text/html", interactiveHtml);
  const disabled = await app.inject({
    method: "PUT",
    url: "/api/pages/trusted-interactive?type=interactive",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": disabledBody.contentType,
    },
    payload: disabledBody.payload,
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.json().error, "interactive_disabled");

  const login = await shooLogin("interactive-shoo-user-1234567890");
  const cookie = responseCookie(login, "__Secure-schaffa_user");
  const user = db()
    .prepare("SELECT id FROM users WHERE shoo_subject = ?")
    .get("interactive-shoo-user-1234567890") as unknown as { id: string };
  await updateSettings({ interactivePublishingEnabled: true });
  const granted = await app.inject({
    method: "POST",
    url: `/admin/users/${user.id}/interactive`,
    headers: {
      host: "schaffa.test",
      cookie: adminCookie(bootstrapToken),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "allowed=true",
  });
  assert.equal(granted.statusCode, 302);

  const tokenPage = await app.inject({
    method: "POST",
    url: "/account/tokens",
    headers: {
      host: "schaffa.test",
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "name=interactive-agent&scope=interactive",
  });
  assert.equal(tokenPage.statusCode, 200);
  const token = /sfa_[A-Za-z0-9_-]+/.exec(tokenPage.body)?.[0];
  assert.ok(token);

  const body = multipart("html", "interactive.html", "text/html", interactiveHtml);
  const published = await app.inject({
    method: "POST",
    url: "/api/pages?type=interactive",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${token}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(published.statusCode, 202);
  await finishPendingScans();
  assert.equal(published.json().kind, "interactive");
  const pageSlug = published.json().slug as string;
  assert.match(pageSlug, /^[a-z0-9]{16}$/);

  const warning = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(warning.statusCode, 200);
  assert.match(warning.body, /Diese Seite führt Code aus/);
  assert.doesNotMatch(warning.body, /document\.body\.dataset/);
  assert.match(warning.body, new RegExp(`/p/${pageSlug}/run`));

  const run = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}/run`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(run.statusCode, 200);
  assert.equal(run.body, interactiveHtml);
  assert.match(String(run.headers["content-security-policy"]), /sandbox allow-scripts/);
  assert.match(String(run.headers["content-security-policy"]), /connect-src 'none'/);
  assert.match(String(run.headers["content-security-policy"]), /webrtc 'block'/);
  assert.doesNotMatch(String(run.headers["content-security-policy"]), /allow-same-origin/);
  assert.match(String(run.headers["permissions-policy"]), /camera=\(\)/);
  assert.equal(run.headers["x-dns-prefetch-control"], "off");

  const raw = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}/raw`,
    headers: { host: "schaffa.test" },
  });
  assert.match(raw.headers["content-type"] || "", /^text\/plain/);
  assert.equal(raw.body, interactiveHtml);

  const externalBody = multipart(
    "html",
    "external.html",
    "text/html",
    '<script src="https://example.test/app.js"></script>',
  );
  const external = await app.inject({
    method: "PUT",
    url: "/api/pages/external-interactive?type=interactive",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${token}`,
      "content-type": externalBody.contentType,
    },
    payload: externalBody.payload,
  });
  assert.equal(external.statusCode, 422);
  assert.equal(external.json().error, "unsafe_html");

  const staticBody = multipart("html", "static.html", "text/html", "<h1>Static now</h1>");
  const kindChange = await app.inject({
    method: "PUT",
    url: `/api/pages/${pageSlug}`,
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": staticBody.contentType,
    },
    payload: staticBody.payload,
  });
  assert.equal(kindChange.statusCode, 409);
  assert.equal(kindChange.json().error, "page_kind_mismatch");

  await updateSettings({ interactivePublishingEnabled: false });
  const globallyStoppedRun = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}/run`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(globallyStoppedRun.statusCode, 503);
  assert.equal(globallyStoppedRun.json().error, "interactive_disabled");
  const globallyStoppedWarning = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}`,
    headers: { host: "schaffa.test" },
  });
  assert.doesNotMatch(globallyStoppedWarning.body, /Seite isoliert starten/);
  await updateSettings({ interactivePublishingEnabled: true });

  await app.inject({
    method: "POST",
    url: `/admin/users/${user.id}/interactive`,
    headers: {
      host: "schaffa.test",
      cookie: adminCookie(bootstrapToken),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "allowed=false",
  });
  const stoppedRun = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}/run`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(stoppedRun.statusCode, 503);
  assert.equal(stoppedRun.json().error, "interactive_disabled");
  const stoppedWarning = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}`,
    headers: { host: "schaffa.test" },
  });
  assert.match(stoppedWarning.body, /Ausführung wurde.+deaktiviert/);
  assert.doesNotMatch(stoppedWarning.body, /Seite isoliert starten/);
  const revokedBody = multipart("html", "revoked.html", "text/html", interactiveHtml);
  const revoked = await app.inject({
    method: "PUT",
    url: "/api/pages/revoked-interactive?type=interactive",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${token}`,
      "content-type": revokedBody.contentType,
    },
    payload: revokedBody.payload,
  });
  assert.equal(revoked.statusCode, 401);
  await updateSettings({ interactivePublishingEnabled: false });
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
    method: "POST",
    url: `/admin/users/${user.id}/delete`,
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(removed.statusCode, 302);
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

test("bootstrap can be revoked after another admin exists and never resurrects", async () => {
  const replacement = createToken("replacement admin", ["admin"]);
  const revoked = await app.inject({
    method: "POST",
    url: "/admin/tokens/bootstrap/revoke",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(revoked.statusCode, 302);
  assert.deepEqual(seedBootstrapToken(), { active: false, created: false });

  const oldToken = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.match(oldToken.body, /Admin-Zugang/);
  const newToken = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(replacement.token) },
  });
  assert.equal(newToken.statusCode, 200);
  assert.match(newToken.body, /Publikationen/);
});

test("rotating the bootstrap value reactivates it as the admin recovery path", async () => {
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
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.match(oldToken.body, /Admin-Zugang/);
  const rotated = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(rotatedToken) },
  });
  assert.equal(rotated.statusCode, 200);
  assert.match(rotated.body, /Publikationen/);

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
  for (const [key, value] of Object.entries(settings)) {
    const response = await app.inject({
      method: "POST",
      url: "/admin/settings",
      headers: {
        host: "schaffa.test",
        cookie: adminCookie(bootstrapToken),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `${encodeURIComponent(key)}=${value}`,
    });
    assert.equal(response.statusCode, 302);
  }
}

function adminCookie(token: string): string {
  return `__Secure-schaffa_admin=${token}`;
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

async function publishHtmlWithToken(slug: string, html: string, token: string, title?: string) {
  const response = await queueHtmlWithToken(slug, html, token, title);
  if (response.statusCode === 202) await finishPendingScans();
  return response;
}

async function queueHtmlWithToken(slug: string, html: string, token: string, title?: string) {
  const exists = Boolean(db().prepare("SELECT 1 FROM pages WHERE slug = ?").get(slug));
  const body = multipart("html", "page.html", "text/html", html);
  const response = await app.inject({
    method: exists ? "PUT" : "POST",
    url: `${exists ? `/api/pages/${slug}` : "/api/pages"}${title ? `?title=${encodeURIComponent(title)}` : ""}`,
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${token}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  if (exists || response.statusCode !== 202) return response;

  const result = response.json() as Record<string, unknown>;
  const randomSlug = String(result.slug);
  await rename(
    path.join(dataDir, "quarantine", "pages", randomSlug),
    path.join(dataDir, "quarantine", "pages", slug),
  );
  db()
    .prepare(
      "UPDATE page_versions SET storage_path = replace(storage_path, ?, ?) WHERE page_id = (SELECT id FROM pages WHERE slug = ?)",
    )
    .run(`/pages/${randomSlug}/`, `/pages/${slug}/`, randomSlug);
  db().prepare("UPDATE pages SET slug = ? WHERE slug = ?").run(slug, randomSlug);
  const aliased = JSON.parse(JSON.stringify(result).replaceAll(randomSlug, slug)) as Record<
    string,
    unknown
  >;
  return new Proxy(response, {
    get(target, property, receiver) {
      if (property === "body") return JSON.stringify(aliased);
      if (property === "json") return () => aliased;
      return Reflect.get(target, property, receiver);
    },
  });
}

async function finishPendingScans(): Promise<void> {
  while (pendingScanCount() > 0) {
    const result = await processNextPendingScan();
    assert.equal(result.processed, true);
    if (result.status === "pending") return;
  }
}

async function waitForStalledScanner(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (stalledScannerSockets.size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Scanner request did not reach the stalled test server.");
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

function multipartFields(
  fields: Record<string, string>,
  fileField: string,
  filename: string,
  mediaType: string,
  content: Buffer,
) {
  const boundary = "----schaffa-guide-test-boundary";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat(chunks),
  };
}
