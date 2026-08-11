import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import type { MultipartFile } from "@fastify/multipart";
import { extension as extensionForMediaType, lookup } from "mime-types";
import { config } from "./config.js";
import { db, type FileRow, type PageRow, type PageVersionRow, type TokenRow } from "./db.js";
import { AppError } from "./errors.js";
import { validateHtml } from "./html-policy.js";
import { isFileId, randomFileId, randomPageSlug } from "./ids.js";
import { cleanImage, isLikelyImage } from "./image-cleaner.js";
import {
  readStoredFile,
  removePage,
  removeUpload,
  sha256,
  storePage,
  storeUpload,
  validateSlug,
} from "./storage.js";

export interface PageSummary extends PageRow {
  version_count: number;
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

let pageWriteQueue = Promise.resolve();

export async function publishPage(input: {
  slug: string;
  title?: string;
  html: Buffer;
  tokenId: string;
  anonymous?: boolean;
}): Promise<PublishedPage> {
  const operation = pageWriteQueue.then(() => publishPageLocked(input));
  pageWriteQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
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
  const pageId = existing?.id || randomUUID();
  const version = (existing?.current_version || 0) + 1;
  const storagePath = await storePage(slug, version, input.html);
  const digest = sha256(input.html);
  const versionId = randomUUID();
  const now = Date.now();
  const expiresAt = input.anonymous
    ? sqliteTimestamp(now + config.anonymousPageTtlSeconds * 1000)
    : null;
  const purgeAt = input.anonymous
    ? sqliteTimestamp(now + config.anonymousPageRetentionDays * 24 * 60 * 60 * 1000)
    : null;

  db().exec("BEGIN IMMEDIATE");
  try {
    if (existing) {
      db()
        .prepare(
          `UPDATE pages
           SET title = COALESCE(?, title), current_version = ?, updated_at = CURRENT_TIMESTAMP,
               expires_at = ?, purge_at = ?
           WHERE id = ?`,
        )
        .run(title, version, expiresAt, purgeAt, pageId);
    } else {
      db()
        .prepare(
          `INSERT INTO pages (id, slug, title, current_version, expires_at, purge_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(pageId, slug, title, version, expiresAt, purgeAt);
    }
    db()
      .prepare(
        `INSERT INTO page_versions
         (id, page_id, version, storage_path, bytes, sha256, created_by_token_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(versionId, pageId, version, storagePath, input.html.length, digest, input.tokenId);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }

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

export async function publishFile(part: MultipartFile, tokenId: string): Promise<PublishedFile> {
  const id = randomFileId();
  let filename: string;
  let mediaType: string;
  let stored: Awaited<ReturnType<typeof storeUpload>>;

  if (isLikelyImage(part.filename, part.mimetype)) {
    const input = await part.toBuffer();
    if (part.file.truncated) {
      throw new AppError("File exceeds the configured size limit.", 413, "file_too_large");
    }
    const cleaned = await cleanImage(input);
    if (cleaned.data.length > config.maxFileBytes) {
      throw new AppError("Cleaned image exceeds the configured size limit.", 413, "file_too_large");
    }
    filename = `${id}.${cleaned.extension}`;
    mediaType = cleaned.mediaType;
    stored = await storeUpload(id, filename, Readable.from([cleaned.data]));
  } else {
    const extension = neutralExtension(part.filename, part.mimetype);
    filename = `${id}.${extension}`;
    mediaType =
      (part.mimetype === "application/octet-stream" ? lookup(filename) : part.mimetype) ||
      "application/octet-stream";
    stored = await storeUpload(id, filename, part.file);
    if (part.file.truncated) {
      await removeUpload(id);
      throw new AppError("File exceeds the configured size limit.", 413, "file_too_large");
    }
  }

  try {
    db()
      .prepare(
        `INSERT INTO files
         (id, filename, storage_path, media_type, bytes, sha256, created_by_token_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, filename, stored.storagePath, mediaType, stored.bytes, stored.sha256, tokenId);
  } catch (error) {
    await removeUpload(id);
    throw error;
  }

  return {
    id,
    filename,
    mediaType,
    bytes: stored.bytes,
    sha256: stored.sha256,
    publicUrl: filePublicUrl(filename),
  };
}

export function listPages(): PageSummary[] {
  return db()
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
    .all() as unknown as PageSummary[];
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
      `SELECT id, name, '' AS token_hash, scopes, created_at, last_used_at, revoked_at
       FROM tokens WHERE id != 'anonymous' ORDER BY created_at DESC`,
    )
    .all() as unknown as TokenRow[];
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
