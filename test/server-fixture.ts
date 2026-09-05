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
  INSERT INTO guides (id, slug, title, status, owner_token_id)
  VALUES ('legacy-guide-id', 'abc234def567', 'Legacy guide', 'draft', 'legacy-token');
  INSERT INTO page_versions
    (id, page_id, version, storage_path, bytes, sha256, created_by_token_id)
  VALUES
    ('legacy-version-id', 'legacy-page-id', 1, 'pages/legacy-page/1.html', 1, '00', 'legacy-token');
`);
legacyDb.close();
const bootstrapToken = `sfa_${"a".repeat(43)}`;
const scannerState: { mode: "ok" | "infected" | "unavailable" | "error" | "stall" } = {
  mode: "ok",
};
const stalledScannerSockets = new Set<net.Socket>();
const scanner = net.createServer({ allowHalfOpen: true }, (socket) => {
  const request: Buffer[] = [];
  socket.on("data", (chunk) =>
    request.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
  );
  socket.on("end", () => {
    const framed = Buffer.concat(request);
    assert.equal(framed.subarray(0, 10).toString(), "zINSTREAM\0");
    let offset = 10;
    let bytes = 0;
    while (true) {
      assert.ok(offset + 4 <= framed.length);
      const length = framed.readUInt32BE(offset);
      offset += 4;
      if (length === 0) break;
      assert.ok(length <= 64 * 1024 && offset + length <= framed.length);
      bytes += length;
      offset += length;
    }
    assert.equal(offset, framed.length);
    assert.ok(bytes > 0);

    if (scannerState.mode === "unavailable") return socket.destroy();
    if (scannerState.mode === "stall") {
      stalledScannerSockets.add(socket);
      return;
    }
    const response =
      scannerState.mode === "infected"
        ? "stream: Eicar-Test-Signature FOUND\0"
        : scannerState.mode === "error"
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
process.env.TRUSTED_PROXIES = "127.0.0.1,::1";

const { buildServer } = await import("../src/server.js");
const { config } = await import("../src/config.js");
const { db } = await import("../src/db.js");
const { createToken, seedBootstrapToken } = await import("../src/auth.js");
const { allSkillsMarkdown, exampleSkills } = await import("../src/example-skills.js");
const { cleanImage } = await import("../src/image-cleaner.js");
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

const initialConfig = { ...config };
test.afterEach(() => {
  scannerState.mode = "ok";
  Object.assign(config, initialConfig);
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
    db().exec(
      "UPDATE page_versions SET scan_attempted_at = datetime('now', '-3 seconds') WHERE scan_status = 'pending'; UPDATE files SET scan_attempted_at = datetime('now', '-3 seconds') WHERE scan_status = 'pending'",
    );
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

interface TestClickMarker {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  box?: { left: number; top: number; width: number; height: number };
}

interface RgbImage {
  data: Buffer;
  width: number;
  height: number;
}

async function renderMarkedScreenshot(
  width: number,
  height: number,
  marker: TestClickMarker,
): Promise<RgbImage> {
  const source = await sharp({
    create: { width, height, channels: 4, background: "#475569" },
  })
    .png()
    .toBuffer();
  const cleaned = await cleanImage(source, marker);
  return decodeRgbImage(cleaned.data);
}

async function decodeRgbImage(data: Buffer): Promise<RgbImage> {
  const decoded = await sharp(data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

function assertRedNear(
  image: RgbImage,
  centerX: number,
  centerY: number,
  radius: number,
  label: string,
): void {
  assert.ok(
    redPixelCount(image, centerX, centerY, radius) > 0,
    `${label} should contain a red marker pixel near (${centerX}, ${centerY}).`,
  );
}

function assertNoRedNear(
  image: RgbImage,
  centerX: number,
  centerY: number,
  radius: number,
  label: string,
): void {
  assert.equal(
    redPixelCount(image, centerX, centerY, radius),
    0,
    `${label} should not contain marker-red pixels near (${centerX}, ${centerY}).`,
  );
}

function assertLightNear(
  image: RgbImage,
  centerX: number,
  centerY: number,
  radius: number,
  label: string,
): void {
  const minimumX = Math.max(0, Math.floor(centerX - radius));
  const maximumX = Math.min(image.width - 1, Math.ceil(centerX + radius));
  const minimumY = Math.max(0, Math.floor(centerY - radius));
  const maximumY = Math.min(image.height - 1, Math.ceil(centerY + radius));
  let count = 0;
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const [red, green, blue] = rgbAt(image, x, y);
      if (red >= 190 && green >= 190 && blue >= 190) count += 1;
    }
  }
  assert.ok(count > 0, `${label} should contain part of the white cursor fill.`);
}

function redPixelCount(image: RgbImage, centerX: number, centerY: number, radius: number): number {
  const minimumX = Math.max(0, Math.floor(centerX - radius));
  const maximumX = Math.min(image.width - 1, Math.ceil(centerX + radius));
  const minimumY = Math.max(0, Math.floor(centerY - radius));
  const maximumY = Math.min(image.height - 1, Math.ceil(centerY + radius));
  let count = 0;
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const offset = (y * image.width + x) * 3;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      if (red >= 150 && red >= green + 45 && red >= blue + 25) count += 1;
    }
  }
  return count;
}

function redPixelBounds(image: RgbImage): {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
} | null {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const [red, green, blue] = rgbAt(image, x, y);
      if (red < 150 || red < green + 45 || red < blue + 25) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left
    ? null
    : { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

function assertSlateBackground(pixel: [number, number, number], label: string): void {
  assert.ok(
    pixel[0] < 140 && pixel[1] < 150 && pixel[2] < 170,
    `${label} should remain readable instead of being covered by the white cursor: ${pixel.join(",")}`,
  );
}

function rgbAt(image: RgbImage, x: number, y: number): [number, number, number] {
  const offset = (y * image.width + x) * 3;
  return [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0];
}

export {
  adminCookie,
  allSkillsMarkdown,
  app,
  assert,
  assertLightNear,
  assertNoRedNear,
  assertRedNear,
  assertSlateBackground,
  bootstrapToken,
  cleanImage,
  config,
  createToken,
  dataDir,
  db,
  decodeRgbImage,
  exampleSkills,
  finishPendingScans,
  multipart,
  multipartFields,
  path,
  pendingScanCount,
  processNextPendingScan,
  publishHtml,
  publishHtmlWithToken,
  purgeRetainedAnonymousPages,
  queueHtmlWithToken,
  readFile,
  redPixelBounds,
  redPixelCount,
  rename,
  renderMarkedScreenshot,
  responseCookie,
  rgbAt,
  rm,
  scannerState,
  seedBootstrapToken,
  sharp,
  shooLogin,
  stalledScannerSockets,
  test,
  updateSettings,
  waitForStalledScanner,
};
