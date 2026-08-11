import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface UploadOptions {
  filePath: string;
  token?: string;
  baseUrl?: string;
  slug?: string;
  fetch?: typeof fetch;
}

export interface UploadResult {
  publicUrl: string;
  [key: string]: unknown;
}

const mediaTypes = new Map([
  [".css", "text/css"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
]);

export async function upload(options: UploadOptions): Promise<UploadResult> {
  const fileStat = await stat(options.filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(`File not found: ${options.filePath}`);
  }
  if (options.token && (!options.token.startsWith("sfa_") || options.token.length < 40)) {
    throw new Error("SCHAFFA_TOKEN must be a valid high-entropy Schaffa token.");
  }

  const origin = canonicalOrigin(options.baseUrl || "https://schaffa.dev");
  const extension = path.extname(options.filePath).toLowerCase();
  const isHtml = extension === ".html" || extension === ".htm";
  if (options.slug && !isHtml) {
    throw new Error("--slug can only be used with an HTML file.");
  }
  if (!options.token && !isHtml) {
    throw new Error(
      "SCHAFFA_TOKEN is required to upload files. Anonymous uploads accept HTML only.",
    );
  }
  if (!options.token && options.slug) {
    throw new Error("SCHAFFA_TOKEN is required to update an existing page.");
  }
  if (options.slug && !isValidSlug(options.slug)) {
    throw new Error("--slug must contain 1-63 lowercase letters, numbers, or hyphens.");
  }

  const form = new FormData();
  const data = await readFile(options.filePath);
  const mediaType = isHtml ? "text/html" : mediaTypes.get(extension) || "application/octet-stream";
  const field = isHtml ? "html" : "file";
  form.append(field, new Blob([data], { type: mediaType }), path.basename(options.filePath));

  const endpoint = isHtml
    ? options.slug
      ? `/api/pages/${encodeURIComponent(options.slug)}`
      : "/api/pages"
    : "/api/files";
  const headers = options.token ? { Authorization: `Bearer ${options.token}` } : undefined;
  const response = await (options.fetch || fetch)(new URL(endpoint, origin), {
    method: options.slug ? "PUT" : "POST",
    ...(headers ? { headers } : {}),
    body: form,
  });
  const body = await response.text();
  const result = parseResponse(body);
  if (!response.ok) {
    const detail = typeof result.message === "string" ? ` ${result.message}` : "";
    throw new Error(`Schaffa request failed with HTTP ${response.status}.${detail}`);
  }
  if (typeof result.publicUrl !== "string") {
    throw new Error("Schaffa returned a response without a public URL.");
  }
  return result as UploadResult;
}

function canonicalOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SCHAFFA_URL must be a valid HTTP or HTTPS origin.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("SCHAFFA_URL must be an HTTP or HTTPS origin without a path or credentials.");
  }
  return parsed.origin;
}

function isValidSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function parseResponse(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
