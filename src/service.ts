import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import type { MultipartFile } from "@fastify/multipart";
import { extension as extensionForMediaType, lookup } from "mime-types";
import { anonymousActorId } from "./auth.js";
import { config } from "./config.js";
import { db, type FileRow, type PageRow, type PageVersionRow, type TokenRow } from "./db.js";
import { AppError } from "./errors.js";
import { validateHtml } from "./html-policy.js";
import { isFileId, randomFileId, randomPageSlug } from "./ids.js";
import { cleanImage, isLikelyImage, withImageProcessingPermit } from "./image-cleaner.js";
import {
  readStoredFile,
  removePage,
  removeStoredFile,
  removeUpload,
  sha256,
  storePage,
  storeUpload,
  validateSlug,
} from "./storage.js";
import { scanStoredUpload, scanUpload } from "./virus-scanner.js";

export interface PageSummary extends PageRow {
  version_count: number;
  version_numbers: number[];
  latest_bytes: number;
  uploader_id: string;
  uploader_name: string;
}

export interface FileSummary extends FileRow {
  uploader_id: string;
  uploader_name: string;
}

export interface PublishedPage {
  slug: string;
  title: string | null;
  version: number;
  bytes: number;
  sha256: string;
  publicUrl: string;
  rawUrl: string;
  versionUrl: string;
  versionRawUrl: string;
  expiresAt: string | null;
  purgeAt: string | null;
}

export interface PublishedFile {
  id: string;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  publicUrl: string;
}

let metadataWriteQueue = Promise.resolve();
let reservedStorageBytes = 0;

function serializeMetadataWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = metadataWriteQueue.then(operation);
  metadataWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function publishPage(input: {
  slug: string;
  title?: string;
  html: Buffer;
  tokenId: string;
  anonymous?: boolean;
  isAdmin?: boolean;
}): Promise<PublishedPage> {
  return serializeMetadataWrite(() => publishPageLocked(input));
}

export function newPageSlug(): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = randomPageSlug();
    const exists = db().prepare("SELECT 1 FROM pages WHERE slug = ?").get(slug);
    if (!exists) return slug;
  }
  throw new Error("Could not allocate a unique page slug.");
}

async function publishPageLocked(input: {
  slug: string;
  title?: string;
  html: Buffer;
  tokenId: string;
  anonymous?: boolean;
  isAdmin?: boolean;
}): Promise<PublishedPage> {
  const slug = validateSlug(input.slug);
  if (input.html.length === 0) throw new AppError("HTML file is empty.", 422, "empty_file");
  if (input.html.length > config.maxPageBytes) {
    throw new AppError("HTML file exceeds the configured size limit.", 413, "file_too_large");
  }

  const html = input.html.toString("utf8");
  if (Buffer.byteLength(html, "utf8") !== input.html.length) {
    throw new AppError("HTML must be valid UTF-8.", 422, "invalid_encoding");
  }
  validateHtml(html);

  const title = input.title?.trim() || null;
  if (title && title.length > 160) throw new AppError("Title may not exceed 160 characters.");

  const existing = db().prepare("SELECT * FROM pages WHERE slug = ?").get(slug) as unknown as
    | PageRow
    | undefined;
  if (existing?.owner_token_id === anonymousActorId || existing?.expires_at) {
    throw new AppError("Anonymous pages cannot be updated.", 409, "anonymous_page");
  }
  if (existing && existing.owner_token_id !== input.tokenId && !input.isAdmin) {
    throw new AppError("This token does not own the page.", 403, "forbidden");
  }
  const pageId = existing?.id || randomUUID();
  const version = (existing?.current_version || 0) + 1;
  const digest = sha256(input.html);
  const versionId = randomUUID();
  const now = Date.now();
  const expiresAt = input.anonymous
    ? sqliteTimestamp(now + config.anonymousPageTtlSeconds * 1000)
    : null;
  const purgeAt = input.anonymous
    ? sqliteTimestamp(now + config.anonymousPageRetentionDays * 24 * 60 * 60 * 1000)
    : null;
  if (input.anonymous) await makeAnonymousCapacity(input.html.length);

  const prunable = existing
    ? (db()
        .prepare(
          `SELECT storage_path, bytes FROM page_versions
           WHERE page_id = ? ORDER BY version ASC
           LIMIT MAX(0, (SELECT COUNT(*) + 1 - ? FROM page_versions WHERE page_id = ?))`,
        )
        .all(pageId, config.maxPageVersions, pageId) as unknown as Array<{
        storage_path: string;
        bytes: number;
      }>)
    : [];
  assertStorageCapacity(input.html.length - prunable.reduce((total, row) => total + row.bytes, 0));
  const storagePath = await storePage(slug, version, input.html);

  db().exec("BEGIN IMMEDIATE");
  try {
    if (existing) {
      db()
        .prepare(
          `UPDATE pages
           SET title = COALESCE(?, title), current_version = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(title, version, pageId);
    } else {
      db()
        .prepare(
          `INSERT INTO pages
           (id, slug, title, current_version, expires_at, purge_at, owner_token_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(pageId, slug, title, version, expiresAt, purgeAt, input.tokenId);
    }
    db()
      .prepare(
        `INSERT INTO page_versions
         (id, page_id, version, storage_path, bytes, sha256, created_by_token_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(versionId, pageId, version, storagePath, input.html.length, digest, input.tokenId);
    if (prunable.length > 0) {
      db()
        .prepare(
          `DELETE FROM page_versions
           WHERE page_id = ? AND id IN (
             SELECT id FROM page_versions WHERE page_id = ?
             ORDER BY version ASC LIMIT ?
           )`,
        )
        .run(pageId, pageId, prunable.length);
    }
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    await removeStoredFile(storagePath);
    throw error;
  }
  await Promise.all(prunable.map((row) => removeStoredFile(row.storage_path)));

  return {
    slug,
    title,
    version,
    bytes: input.html.length,
    sha256: digest,
    publicUrl: `${config.baseUrl}/p/${slug}`,
    rawUrl: `${config.baseUrl}/p/${slug}/raw`,
    versionUrl: `${config.baseUrl}/p/${slug}/${version}`,
    versionRawUrl: `${config.baseUrl}/p/${slug}/${version}/raw`,
    expiresAt,
    purgeAt,
  };
}

export async function publishFile(
  part: MultipartFile,
  tokenId: string,
  requestBytes?: number,
): Promise<PublishedFile> {
  const id = randomFileId();
  const likelyImage = isLikelyImage(part.filename, part.mimetype);
  const reservationBytes = likelyImage
    ? Math.min(config.maxFileBytes, config.maxPublishedImageBytes)
    : requestBytes && requestBytes > 0
      ? Math.min(config.maxFileBytes, requestBytes)
      : config.maxFileBytes;
  await serializeMetadataWrite(async () => {
    assertStorageCapacity(reservationBytes);
    reservedStorageBytes += reservationBytes;
  });
  let reservationActive = true;
  let prepared:
    | {
        filename: string;
        mediaType: string;
        stored: Awaited<ReturnType<typeof storeUpload>>;
      }
    | undefined;

  try {
    if (likelyImage) {
      prepared = await withImageProcessingPermit(async () => {
        const input = await readUploadBuffer(part.file, config.maxImageInputBytes);
        await scanUpload(input);
        const cleaned = await cleanImage(input);
        if (cleaned.data.length > config.maxFileBytes) {
          throw new AppError(
            "Cleaned image exceeds the configured size limit.",
            413,
            "file_too_large",
          );
        }
        const filename = `${id}.${cleaned.extension}`;
        return {
          filename,
          mediaType: cleaned.mediaType,
          stored: await storeUpload(id, filename, Readable.from([cleaned.data])),
        };
      });
    } else {
      const extension = neutralExtension(part.filename, part.mimetype);
      const filename = `${id}.${extension}`;
      const mediaType =
        (part.mimetype === "application/octet-stream" ? lookup(filename) : part.mimetype) ||
        "application/octet-stream";
      const stored = await storeUpload(id, filename, part.file);
      prepared = { filename, mediaType, stored };
      if (part.file.truncated) {
        throw new AppError("File exceeds the configured size limit.", 413, "file_too_large");
      }
      await scanStoredUpload(stored.storagePath);
    }

    const { filename, mediaType, stored } = prepared;
    await serializeMetadataWrite(async () => {
      reservedStorageBytes -= reservationBytes;
      reservationActive = false;
      assertStorageCapacity(stored.bytes);
      db()
        .prepare(
          `INSERT INTO files
           (id, filename, storage_path, media_type, bytes, sha256, created_by_token_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, filename, stored.storagePath, mediaType, stored.bytes, stored.sha256, tokenId);
    });
  } catch (error) {
    if (reservationActive) {
      await serializeMetadataWrite(async () => {
        reservedStorageBytes -= reservationBytes;
        reservationActive = false;
      });
    }
    if (prepared) await removeUpload(id);
    throw error;
  }

  const { filename, mediaType, stored } = prepared;
  return {
    id,
    filename,
    mediaType,
    bytes: stored.bytes,
    sha256: stored.sha256,
    publicUrl: filePublicUrl(filename),
  };
}

async function readUploadBuffer(input: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunkValue of input) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    bytes += chunk.length;
    if (bytes > limit) {
      throw new AppError("Image input exceeds the configured size limit.", 413, "file_too_large");
    }
    chunks.push(chunk);
  }
  if (input.readableAborted) {
    throw new AppError("File exceeds the configured size limit.", 413, "file_too_large");
  }
  return Buffer.concat(chunks, bytes);
}

export function listPages(): PageSummary[] {
  const pages = db()
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM page_versions pv WHERE pv.page_id = p.id) AS version_count,
              COALESCE(
                (SELECT pv.bytes FROM page_versions pv
                 WHERE pv.page_id = p.id ORDER BY pv.version DESC LIMIT 1),
                0
              ) AS latest_bytes,
              pv.created_by_token_id AS uploader_id,
              COALESCE(t.name, 'Unknown uploader') AS uploader_name
       FROM pages p
       JOIN page_versions pv ON pv.page_id = p.id AND pv.version = p.current_version
       LEFT JOIN tokens t ON t.id = pv.created_by_token_id
       WHERE p.expires_at IS NULL OR datetime(p.expires_at) > CURRENT_TIMESTAMP
       ORDER BY p.updated_at DESC`,
    )
    .all() as unknown as Array<Omit<PageSummary, "version_numbers">>;
  const versions = db().prepare(
    "SELECT version FROM page_versions WHERE page_id = ? ORDER BY version DESC",
  );
  return pages.map((page) => ({
    ...page,
    version_numbers: (versions.all(page.id) as unknown as Array<{ version: number }>).map(
      ({ version }) => version,
    ),
  }));
}

export function listFiles(): FileSummary[] {
  return db()
    .prepare(
      `SELECT f.*, f.created_by_token_id AS uploader_id,
              COALESCE(t.name, 'Unknown uploader') AS uploader_name
       FROM files f
       LEFT JOIN tokens t ON t.id = f.created_by_token_id
       ORDER BY f.created_at DESC`,
    )
    .all() as unknown as FileSummary[];
}

export function listTokens(): TokenRow[] {
  return db()
    .prepare(
      `SELECT id, name, '' AS token_hash, scopes, created_at, last_used_at, revoked_at, user_id
       FROM tokens WHERE id != 'anonymous' ORDER BY created_at DESC`,
    )
    .all() as unknown as TokenRow[];
}

export async function deletePage(slugValue: string): Promise<void> {
  const slug = validateSlug(slugValue);
  const result = db().prepare("DELETE FROM pages WHERE slug = ?").run(slug);
  if (result.changes === 0) throw new AppError("Page not found.", 404, "not_found");
  await removePage(slug);
}

export async function deletePageVersion(slugValue: string, version: number): Promise<void> {
  const slug = validateSlug(slugValue);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AppError("Invalid page version.", 422, "invalid_version");
  }
  const page = db().prepare("SELECT * FROM pages WHERE slug = ?").get(slug) as unknown as
    | PageRow
    | undefined;
  if (!page) throw new AppError("Page not found.", 404, "not_found");
  const selected = db()
    .prepare("SELECT * FROM page_versions WHERE page_id = ? AND version = ?")
    .get(page.id, version) as unknown as PageVersionRow | undefined;
  if (!selected) throw new AppError("Page version not found.", 404, "not_found");

  const remaining = db()
    .prepare(
      "SELECT MAX(version) AS latest, COUNT(*) AS count FROM page_versions WHERE page_id = ?",
    )
    .get(page.id) as unknown as { latest: number; count: number };
  if (remaining.count === 1) {
    await deletePage(slug);
    return;
  }

  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("DELETE FROM page_versions WHERE id = ?").run(selected.id);
    if (page.current_version === version) {
      const latest = db()
        .prepare("SELECT MAX(version) AS version FROM page_versions WHERE page_id = ?")
        .get(page.id) as unknown as { version: number };
      db()
        .prepare(
          "UPDATE pages SET current_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(latest.version, page.id);
    }
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  await removeStoredFile(selected.storage_path);
}

export async function deleteFile(id: string): Promise<void> {
  if (!isFileId(id)) throw new AppError("File not found.", 404, "not_found");
  const result = db().prepare("DELETE FROM files WHERE id = ?").run(id);
  if (result.changes === 0) throw new AppError("File not found.", 404, "not_found");
  await removeUpload(id);
}

export async function getPageVersion(
  slugValue: string,
  version?: number,
): Promise<{ page: PageRow; version: PageVersionRow; html: Buffer } | null> {
  const slug = validateSlug(slugValue);
  const page = db()
    .prepare(
      `SELECT * FROM pages
       WHERE slug = ? AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)`,
    )
    .get(slug) as unknown as PageRow | undefined;
  if (!page) return null;

  const selectedVersion = version ?? page.current_version;
  if (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1) return null;
  const row = db()
    .prepare("SELECT * FROM page_versions WHERE page_id = ? AND version = ?")
    .get(page.id, selectedVersion) as unknown as PageVersionRow | undefined;
  if (!row) return null;
  return { page, version: row, html: await readStoredFile(row.storage_path) };
}

export function getFile(filename: string): FileRow | null {
  const separator = filename.lastIndexOf(".");
  const id = separator > 0 ? filename.slice(0, separator) : "";
  if (!isFileId(id) || !/^[A-Za-z0-9_-]{22}\.[a-z0-9]{1,10}$/.test(filename)) return null;
  return (
    (db().prepare("SELECT * FROM files WHERE filename = ?").get(filename) as unknown as
      | FileRow
      | undefined) || null
  );
}

export function filePublicUrl(filename: string): string {
  return `${config.baseUrl}/f/${filename}`;
}

export async function purgeRetainedAnonymousPages(): Promise<number> {
  const expired = db()
    .prepare(
      `SELECT slug FROM pages
       WHERE purge_at IS NOT NULL AND datetime(purge_at) <= CURRENT_TIMESTAMP`,
    )
    .all() as unknown as Array<{ slug: string }>;
  if (expired.length === 0) return 0;

  const remove = db().prepare("DELETE FROM pages WHERE slug = ?");
  let removed = 0;
  for (const page of expired) {
    await removePage(page.slug);
    removed += Number(remove.run(page.slug).changes > 0);
  }
  return removed;
}

function assertStorageCapacity(additionalBytes: number): void {
  const row = db()
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(bytes) FROM page_versions), 0) +
         COALESCE((SELECT SUM(bytes) FROM files), 0) +
         COALESCE((SELECT SUM(bytes) FROM guide_images), 0) AS bytes`,
    )
    .get() as unknown as { bytes: number };
  if (row.bytes + reservedStorageBytes + additionalBytes > config.maxStorageBytes) {
    throw new AppError("The server storage quota has been reached.", 507, "storage_quota");
  }
}

async function makeAnonymousCapacity(additionalBytes: number): Promise<void> {
  if (additionalBytes > config.maxAnonymousStorageBytes) {
    throw new AppError("The anonymous storage quota has been reached.", 507, "storage_quota");
  }
  const anonymousPages = db()
    .prepare(
      `SELECT p.slug, p.created_at, COALESCE(SUM(pv.bytes), 0) AS bytes
       FROM pages p
       LEFT JOIN page_versions pv ON pv.page_id = p.id
       WHERE p.owner_token_id = ?
       GROUP BY p.id
       ORDER BY p.created_at ASC`,
    )
    .all(anonymousActorId) as unknown as Array<{
    slug: string;
    created_at: string;
    bytes: number;
  }>;
  let totalBytes = anonymousPages.reduce((total, page) => total + page.bytes, 0);
  let totalPages = anonymousPages.length;
  for (const page of anonymousPages) {
    if (
      totalBytes + additionalBytes <= config.maxAnonymousStorageBytes &&
      totalPages + 1 <= config.maxAnonymousPages
    ) {
      break;
    }
    db().prepare("DELETE FROM pages WHERE slug = ?").run(page.slug);
    await removePage(page.slug);
    totalBytes -= page.bytes;
    totalPages -= 1;
  }
  if (
    totalBytes + additionalBytes > config.maxAnonymousStorageBytes ||
    totalPages + 1 > config.maxAnonymousPages
  ) {
    throw new AppError("The anonymous storage quota has been reached.", 507, "storage_quota");
  }
}

function neutralExtension(filename: string, mediaType: string): string {
  const supplied = path.extname(filename).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,10}$/.test(supplied)) return supplied;
  const inferred = extensionForMediaType(mediaType);
  return inferred && /^[a-z0-9]{1,10}$/.test(inferred) ? inferred : "bin";
}

function sqliteTimestamp(timestamp: number): string {
  return new Date(timestamp)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
