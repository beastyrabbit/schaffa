import path from "node:path";

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = positiveInteger(name, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function readBaseUrl(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

const baseUrl = readBaseUrl(
  "SCHAFFA_BASE_URL",
  process.env.PORTLESS_URL || "http://localhost:3000",
);

export const config = {
  host: process.env.HOST || "0.0.0.0",
  port: positiveInteger("PORT", 3000),
  dataDir: path.resolve(process.env.SCHAFFA_DATA_DIR || "./data"),
  baseUrl,
  baseHost: new URL(baseUrl).hostname,
  tokenPepper: process.env.SCHAFFA_TOKEN_PEPPER || "",
  bootstrapToken: process.env.SCHAFFA_BOOTSTRAP_TOKEN || "",
  maxPageBytes: positiveInteger("MAX_PAGE_BYTES", 2 * 1024 * 1024),
  maxFileBytes: positiveInteger("MAX_FILE_BYTES", 256 * 1024 * 1024),
  imageMaxInputPixels: positiveInteger("IMAGE_MAX_INPUT_PIXELS", 40_000_000),
  imageMaxEdge: boundedInteger("IMAGE_MAX_EDGE", 2560, 320, 8192),
  imageWebpQuality: boundedInteger("IMAGE_WEBP_QUALITY", 82, 40, 100),
  maxPublishedImageBytes: positiveInteger("MAX_PUBLISHED_IMAGE_BYTES", 8 * 1024 * 1024),
  anonymousPageTtlSeconds: boundedInteger("ANONYMOUS_PAGE_TTL_SECONDS", 3600, 300, 86400),
  anonymousPageRetentionDays: boundedInteger("ANONYMOUS_PAGE_RETENTION_DAYS", 30, 1, 365),
  anonymousUploadsPerHour: boundedInteger("ANONYMOUS_UPLOADS_PER_HOUR", 20, 1, 1000),
  clamavHost: process.env.CLAMAV_HOST || "",
  clamavPort: boundedInteger("CLAMAV_PORT", 3310, 1, 65535),
  clamavTimeoutMs: boundedInteger("CLAMAV_TIMEOUT_MS", 15_000, 1000, 120_000),
  logLevel: process.env.LOG_LEVEL || "info",
  cookieSecure: new URL(baseUrl).protocol === "https:",
};

export type Config = typeof config;
