import { Readable } from "node:stream";
import { db, type FileRow, type PageVersionRow } from "./db.js";
import { AppError } from "./errors.js";
import { cleanImage, withImageProcessingPermit } from "./image-cleaner.js";
import {
  promoteQuarantinedPage,
  promoteQuarantinedUpload,
  readStoredFile,
  removeStoredFile,
  storeUpload,
} from "./storage.js";
import { scanStoredUpload, synchronousScanDemandCount } from "./virus-scanner.js";

interface PendingPage extends PageVersionRow {
  slug: string;
}

export interface ScanRunResult {
  processed: boolean;
  status?: "clean" | "pending" | "rejected";
  type?: "page" | "file";
}

export function pendingScanCount(): number {
  const result = db()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM page_versions WHERE scan_status IN ('pending','scanning')) +
         (SELECT COUNT(*) FROM files WHERE scan_status IN ('pending','scanning')) AS count`,
    )
    .get() as unknown as { count: number };
  return result.count + synchronousScanDemandCount();
}

export function resetInterruptedScans(): void {
  db().exec(`
    UPDATE page_versions
    SET scan_status = 'pending', scan_message = NULL
    WHERE scan_status = 'scanning';
    UPDATE files
    SET scan_status = 'pending', scan_message = NULL
    WHERE scan_status = 'scanning';
  `);
}

export async function processNextPendingScan(): Promise<ScanRunResult> {
  const page = claimPage();
  if (page) return processPage(page);
  const file = claimFile();
  if (file) return processFile(file);
  return { processed: false };
}

function claimPage(): PendingPage | null {
  db().exec("BEGIN IMMEDIATE");
  try {
    const row = db()
      .prepare(
        `SELECT pv.*, p.slug
         FROM page_versions pv
         JOIN pages p ON p.id = pv.page_id
         WHERE pv.scan_status = 'pending'
         ORDER BY pv.scan_attempted_at IS NOT NULL, pv.scan_attempted_at, pv.created_at, pv.id
         LIMIT 1`,
      )
      .get() as unknown as PendingPage | undefined;
    if (!row) {
      db().exec("COMMIT");
      return null;
    }
    const claimed = db()
      .prepare(
        `UPDATE page_versions
         SET scan_status = 'scanning', scan_attempted_at = CURRENT_TIMESTAMP
         WHERE id = ? AND scan_status = 'pending'`,
      )
      .run(row.id);
    db().exec("COMMIT");
    return claimed.changes === 1 ? { ...row, scan_status: "scanning" } : null;
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}

function claimFile(): FileRow | null {
  db().exec("BEGIN IMMEDIATE");
  try {
    const row = db()
      .prepare(
        `SELECT * FROM files
         WHERE scan_status = 'pending'
         ORDER BY scan_attempted_at IS NOT NULL, scan_attempted_at, created_at, id
         LIMIT 1`,
      )
      .get() as unknown as FileRow | undefined;
    if (!row) {
      db().exec("COMMIT");
      return null;
    }
    const claimed = db()
      .prepare(
        `UPDATE files
         SET scan_status = 'scanning', scan_attempted_at = CURRENT_TIMESTAMP
         WHERE id = ? AND scan_status = 'pending'`,
      )
      .run(row.id);
    db().exec("COMMIT");
    return claimed.changes === 1 ? { ...row, scan_status: "scanning" } : null;
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}

async function processPage(page: PendingPage): Promise<ScanRunResult> {
  try {
    await scanStoredUpload(page.storage_path);
    const publicPath = await promoteQuarantinedPage(
      page.storage_path,
      page.slug,
      page.version,
      page.id,
    );
    const updated = db()
      .prepare(
        `UPDATE page_versions
         SET storage_path = ?, scan_status = 'clean', scan_message = NULL,
             scanned_at = CURRENT_TIMESTAMP
         WHERE id = ? AND scan_status = 'scanning'`,
      )
      .run(publicPath, page.id);
    await removeStoredFile(page.storage_path);
    if (updated.changes === 0) await removeStoredFile(publicPath);
    return { processed: true, status: "clean", type: "page" };
  } catch (error) {
    return handleFailure("page_versions", page.id, page.storage_path, error, "page");
  }
}

async function processFile(file: FileRow): Promise<ScanRunResult> {
  try {
    await scanStoredUpload(file.storage_path);
    let publicPath: string;
    let bytes = file.bytes;
    let digest = file.sha256;
    if (file.process_as_image) {
      const cleaned = await withImageProcessingPermit(async () =>
        cleanImage(await readStoredFile(file.storage_path)),
      );
      const stored = await storeUpload(file.id, file.filename, Readable.from([cleaned.data]));
      publicPath = stored.storagePath;
      bytes = stored.bytes;
      digest = stored.sha256;
    } else {
      publicPath = await promoteQuarantinedUpload(file.storage_path, file.id, file.filename);
    }
    const updated = db()
      .prepare(
        `UPDATE files
         SET storage_path = ?, bytes = ?, sha256 = ?, scan_status = 'clean',
             scan_message = NULL, scanned_at = CURRENT_TIMESTAMP
         WHERE id = ? AND scan_status = 'scanning'`,
      )
      .run(publicPath, bytes, digest, file.id);
    await removeStoredFile(file.storage_path);
    if (updated.changes === 0) await removeStoredFile(publicPath);
    return { processed: true, status: "clean", type: "file" };
  } catch (error) {
    return handleFailure("files", file.id, file.storage_path, error, "file");
  }
}

async function handleFailure(
  table: "page_versions" | "files",
  id: string,
  storagePath: string,
  error: unknown,
  type: "page" | "file",
): Promise<ScanRunResult> {
  if (error instanceof AppError && error.code === "scanner_unavailable") {
    db()
      .prepare(
        `UPDATE ${table}
         SET scan_status = 'pending', scan_message = NULL
         WHERE id = ? AND scan_status = 'scanning'`,
      )
      .run(id);
    return { processed: true, status: "pending", type };
  }
  if (
    error instanceof AppError &&
    (error.code === "malware_detected" || error.code === "scan_rejected")
  ) {
    await removeStoredFile(storagePath);
    rejectScan(table, id, error.message);
    return { processed: true, status: "rejected", type };
  }
  if (type === "file" && error instanceof AppError) {
    await removeStoredFile(storagePath);
    rejectScan(table, id, error.message);
    return { processed: true, status: "rejected", type };
  }
  db()
    .prepare(
      `UPDATE ${table}
       SET scan_status = 'pending', scan_message = NULL
       WHERE id = ? AND scan_status = 'scanning'`,
    )
    .run(id);
  throw error;
}

function rejectScan(table: "page_versions" | "files", id: string, message: string): void {
  db()
    .prepare(
      `UPDATE ${table}
       SET scan_status = 'rejected', scan_message = ?, bytes = 0,
           scanned_at = CURRENT_TIMESTAMP
       WHERE id = ? AND scan_status = 'scanning'`,
    )
    .run(safeScanMessage(message), id);
}

function safeScanMessage(message: string): string {
  const printable = [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  const normalized = printable.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 160) || "Rejected by the virus scanner.";
}
