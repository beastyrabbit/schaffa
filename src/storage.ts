import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { isFileId } from "./ids.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateSlug(value: string): string {
  const slug = value.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new AppError(
      "Slug must be 1-63 lowercase letters, numbers or hyphens.",
      422,
      "invalid_slug",
    );
  }
  return slug;
}

export async function storeQuarantinedPage(
  slugValue: string,
  version: number,
  versionId: string,
  html: Buffer,
): Promise<string> {
  const slug = validateSlug(slugValue);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid page version.");
  if (!uuidPattern.test(versionId)) throw new Error("Invalid page version id.");
  const directory = path.join(config.dataDir, "quarantine", "pages", slug);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const target = path.join(directory, `${version}-${versionId}.html`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, html, { mode: 0o640, flag: "wx" });
  await rename(temporary, target);
  return path.relative(config.dataDir, target);
}

export async function promoteQuarantinedPage(
  storagePath: string,
  slugValue: string,
  version: number,
  versionId: string,
): Promise<string> {
  const slug = validateSlug(slugValue);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid page version.");
  if (!uuidPattern.test(versionId)) throw new Error("Invalid page version id.");
  const expected = path.join("quarantine", "pages", slug, `${version}-${versionId}.html`);
  if (storagePath !== expected) throw new Error("Invalid quarantined page path.");
  const directory = path.join(config.dataDir, "pages", slug);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const target = path.join(directory, `${version}.html`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await copyFile(absoluteStoragePath(storagePath), temporary);
  await rename(temporary, target);
  return path.relative(config.dataDir, target);
}

export async function storeGuideImage(
  guideSlug: string,
  imageId: string,
  data: Buffer,
): Promise<string> {
  const slug = validateSlug(guideSlug);
  if (!/^[A-Za-z0-9_-]{22}$/.test(imageId)) throw new Error("Invalid guide image id.");
  const directory = path.join(config.dataDir, "guides", slug, "images");
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const target = path.join(directory, `${imageId}.webp`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o640, flag: "wx" });
  await rename(temporary, target);
  return path.relative(config.dataDir, target);
}

export async function removeGuide(slugValue: string): Promise<void> {
  const slug = validateSlug(slugValue);
  await rm(path.join(config.dataDir, "guides", slug), { recursive: true, force: true });
}

export async function readStoredFile(relativePath: string): Promise<Buffer> {
  return readFile(absoluteStoragePath(relativePath));
}

export function openStoredFile(relativePath: string, range?: { start: number; end: number }) {
  return createReadStream(absoluteStoragePath(relativePath), range);
}

export async function storeUpload(
  id: string,
  filename: string,
  input: NodeJS.ReadableStream,
): Promise<{ storagePath: string; bytes: number; sha256: string }> {
  return storeUploadAt("files", id, filename, input);
}

export async function storeQuarantinedUpload(
  id: string,
  filename: string,
  input: NodeJS.ReadableStream,
): Promise<{ storagePath: string; bytes: number; sha256: string }> {
  return storeUploadAt(path.join("quarantine", "files"), id, filename, input);
}

async function storeUploadAt(
  root: string,
  id: string,
  filename: string,
  input: NodeJS.ReadableStream,
): Promise<{ storagePath: string; bytes: number; sha256: string }> {
  if (!isFileId(id) || !new RegExp(`^${id}\\.[a-z0-9]{1,10}$`).test(filename)) {
    throw new AppError("Invalid generated storage filename.", 500, "internal_error");
  }
  const directory = path.join(config.dataDir, root, id);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const target = path.join(directory, filename);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(input, meter, createWriteStream(temporary, { flags: "wx", mode: 0o640 }));
    await rename(temporary, target);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  if (bytes === 0) {
    await rm(directory, { recursive: true, force: true });
    throw new AppError("Empty files are not accepted.", 422, "empty_file");
  }

  return {
    storagePath: path.relative(config.dataDir, target),
    bytes,
    sha256: hash.digest("hex"),
  };
}

export async function promoteQuarantinedUpload(
  storagePath: string,
  id: string,
  filename: string,
): Promise<string> {
  if (!isFileId(id) || !new RegExp(`^${id}\\.[a-z0-9]{1,10}$`).test(filename)) {
    throw new Error("Invalid upload identity.");
  }
  const expected = path.join("quarantine", "files", id, filename);
  if (storagePath !== expected) throw new Error("Invalid quarantined upload path.");
  const directory = path.join(config.dataDir, "files", id);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const target = path.join(directory, filename);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await copyFile(absoluteStoragePath(storagePath), temporary);
  await rename(temporary, target);
  return path.relative(config.dataDir, target);
}

export async function removeUpload(id: string): Promise<void> {
  if (!isFileId(id)) throw new Error("Invalid upload id.");
  await Promise.all([
    rm(path.join(config.dataDir, "files", id), { recursive: true, force: true }),
    rm(path.join(config.dataDir, "quarantine", "files", id), {
      recursive: true,
      force: true,
    }),
  ]);
}

export async function removePage(slugValue: string): Promise<void> {
  const slug = validateSlug(slugValue);
  await Promise.all([
    rm(path.join(config.dataDir, "pages", slug), { recursive: true, force: true }),
    rm(path.join(config.dataDir, "quarantine", "pages", slug), {
      recursive: true,
      force: true,
    }),
  ]);
}

export async function removeStoredFile(relativePath: string): Promise<void> {
  await unlink(absoluteStoragePath(relativePath)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function absoluteStoragePath(relativePath: string): string {
  const absolute = path.resolve(config.dataDir, relativePath);
  const prefix = `${config.dataDir}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new Error("Invalid storage path.");
  return absolute;
}
