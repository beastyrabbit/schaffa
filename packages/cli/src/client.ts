import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface UploadOptions {
  filePath: string;
  token?: string;
  baseUrl?: string;
  interactive?: boolean;
  fetch?: typeof fetch;
}

export interface UploadResult {
  publicUrl: string;
  scanStatus?: "pending";
  statusUrl?: string;
  [key: string]: unknown;
}

export class SchaffaRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SchaffaRequestError";
    this.status = status;
  }
}

export interface GuideResult {
  slug: string;
  targetUrl: string | null;
  status: "recording" | "draft" | "published";
  revision: number;
  editRevision: number;
  publicUrl: string;
  apiUrl: string;
  steps: Array<{
    id: string;
    position: number;
    title: string;
    description?: string;
    screenshotUrl?: string | null;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface GuidePreflightResult {
  ready: boolean;
  errors: string[];
  warnings: string[];
  missingScreenshots: string[];
  sensitiveFindings: Array<{ stepId: string; kind: string }>;
}

export interface GuideOperationResult {
  guide: GuideResult;
  preflight: GuidePreflightResult;
  revisionUrl?: string;
}

export interface GuideClickMarker {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  box?: { left: number; top: number; width: number; height: number };
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
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
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
  if (
    options.token !== undefined &&
    (!options.token.startsWith("sfa_") || options.token.length < 40)
  ) {
    throw new Error("SCHAFFA_TOKEN must be a valid high-entropy Schaffa token.");
  }

  const origin = canonicalOrigin(options.baseUrl || "https://schaffa.dev");
  const extension = path.extname(options.filePath).toLowerCase();
  const isHtml = extension === ".html" || extension === ".htm";
  if (options.interactive && !isHtml) {
    throw new Error("--interactive can only be used with an HTML file.");
  }
  if (options.interactive && !options.token) {
    throw new Error("SCHAFFA_TOKEN is required for interactive publishing.");
  }
  if (!options.token && !isHtml) {
    throw new Error(
      "SCHAFFA_TOKEN is required to upload files. Anonymous uploads accept HTML only.",
    );
  }
  const form = new FormData();
  const data = await readFile(options.filePath);
  const mediaType = isHtml ? "text/html" : mediaTypes.get(extension) || "application/octet-stream";
  const field = isHtml ? "html" : "file";
  form.append(field, new Blob([data], { type: mediaType }), path.basename(options.filePath));

  const endpoint = isHtml ? "/api/pages" : "/api/files";
  const headers = options.token ? { Authorization: `Bearer ${options.token}` } : undefined;
  const target = new URL(endpoint, origin);
  if (options.interactive) target.searchParams.set("type", "interactive");
  const response = await (options.fetch || fetch)(target, {
    method: "POST",
    ...(headers ? { headers } : {}),
    body: form,
  });
  const body = await response.text();
  const result = parseResponse(body);
  if (!response.ok) {
    const detail = typeof result.message === "string" ? ` ${result.message}` : "";
    throw new SchaffaRequestError(
      response.status,
      `Schaffa request failed with HTTP ${response.status}.${detail}`,
    );
  }
  if (typeof result.publicUrl !== "string") {
    throw new Error("Schaffa returned a response without a public URL.");
  }
  return result as UploadResult;
}

export async function startGuide(options: {
  title: string;
  description?: string;
  targetUrl?: string;
  language?: string;
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): Promise<GuideResult> {
  return guideRequest(options, "/api/guides", {
    method: "POST",
    body: JSON.stringify({
      title: options.title,
      ...(options.description ? { description: options.description } : {}),
      ...(options.targetUrl ? { targetUrl: options.targetUrl } : {}),
      ...(options.language ? { language: options.language } : {}),
    }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function addGuideStep(options: {
  slug: string;
  editRevision: number;
  title: string;
  description: string;
  actionType?: string;
  actionTarget?: string;
  verification?: string;
  screenshot?: string;
  clickMarker?: GuideClickMarker;
  capture?: boolean;
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  idempotencyKey?: string;
}): Promise<GuideResult> {
  const step = {
    title: options.title,
    description: options.description,
    ...(options.actionType
      ? {
          action: {
            type: options.actionType,
            ...(options.actionTarget ? { target: options.actionTarget } : {}),
          },
        }
      : {}),
    ...(options.verification ? { verification: options.verification } : {}),
    ...(options.clickMarker ? { clickMarker: options.clickMarker } : {}),
    capture: options.capture ?? Boolean(options.screenshot),
  };
  const headers: Record<string, string> = {
    "If-Match": String(options.editRevision),
    "Idempotency-Key":
      options.idempotencyKey || `cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  let body: BodyInit;
  if (options.screenshot) {
    const file = await readFile(options.screenshot);
    const form = new FormData();
    form.append("step", JSON.stringify(step));
    form.append(
      "screenshot",
      new Blob([file], {
        type:
          mediaTypes.get(path.extname(options.screenshot).toLowerCase()) ||
          "application/octet-stream",
      }),
      path.basename(options.screenshot),
    );
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(step);
  }
  return guideRequest(options, `/api/guides/${encodeURIComponent(options.slug)}/steps`, {
    method: "POST",
    headers,
    body,
  });
}

export async function getGuide(options: {
  slug: string;
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): Promise<GuideResult> {
  return guideRequest(options, `/api/guides/${encodeURIComponent(options.slug)}`, {
    method: "GET",
  });
}

export async function updateGuideStep(
  options: GuideMutationOptions & {
    stepId: string;
    title?: string;
    description?: string;
    verification?: string;
  },
): Promise<GuideResult> {
  return guideRequest(
    options,
    `/api/guides/${encodeURIComponent(options.slug)}/steps/${encodeURIComponent(options.stepId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Match": String(options.editRevision),
      },
      body: JSON.stringify({
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.verification !== undefined ? { verification: options.verification } : {}),
      }),
    },
  );
}

export async function deleteGuideStep(
  options: GuideMutationOptions & {
    stepId: string;
  },
): Promise<GuideResult> {
  return guideRequest(
    options,
    `/api/guides/${encodeURIComponent(options.slug)}/steps/${encodeURIComponent(options.stepId)}`,
    {
      method: "DELETE",
      headers: { "If-Match": String(options.editRevision) },
    },
  );
}

export async function replaceGuideScreenshot(
  options: GuideMutationOptions & {
    stepId: string;
    screenshot: string;
  },
): Promise<GuideResult> {
  const file = await readFile(options.screenshot);
  const form = new FormData();
  form.append(
    "screenshot",
    new Blob([file], {
      type:
        mediaTypes.get(path.extname(options.screenshot).toLowerCase()) ||
        "application/octet-stream",
    }),
    path.basename(options.screenshot),
  );
  return guideRequest(
    options,
    `/api/guides/${encodeURIComponent(options.slug)}/steps/${encodeURIComponent(options.stepId)}/screenshot`,
    {
      method: "PUT",
      headers: { "If-Match": String(options.editRevision) },
      body: form,
    },
  );
}

export async function finishGuide(options: GuideMutationOptions): Promise<GuideOperationResult> {
  return guideRequest<GuideOperationResult>(
    options,
    `/api/guides/${encodeURIComponent(options.slug)}/finish`,
    {
      method: "POST",
      headers: { "If-Match": String(options.editRevision) },
    },
  );
}

export async function publishGuide(options: GuideMutationOptions): Promise<GuideOperationResult> {
  return guideRequest<GuideOperationResult>(
    options,
    `/api/guides/${encodeURIComponent(options.slug)}/publish`,
    {
      method: "POST",
      headers: { "If-Match": String(options.editRevision) },
    },
  );
}

export interface GuideMutationOptions {
  slug: string;
  editRevision: number;
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

async function guideRequest<T = GuideResult>(
  options: { token?: string; baseUrl?: string; fetch?: typeof fetch },
  endpoint: string,
  init: RequestInit,
): Promise<T> {
  if (!options.token) throw new Error("SCHAFFA_TOKEN is required for guide operations.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${options.token}`);
  const response = await (options.fetch || fetch)(
    new URL(endpoint, canonicalOrigin(options.baseUrl || "https://schaffa.dev")),
    { ...init, headers },
  );
  const body = await response.text();
  const result = parseResponse(body);
  if (!response.ok) {
    const detail = typeof result.message === "string" ? ` ${result.message}` : "";
    throw new SchaffaRequestError(
      response.status,
      `Schaffa request failed with HTTP ${response.status}.${detail}`,
    );
  }
  return result as T;
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

function parseResponse(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
