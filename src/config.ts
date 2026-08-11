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
const shooBaseUrl = readBaseUrl("SHOO_BASE_URL", "https://shoo.dev");

export const config = {
  host: process.env.HOST || "0.0.0.0",
  port: positiveInteger("PORT", 3000),
  dataDir: path.resolve(process.env.SCHAFFA_DATA_DIR || "./data"),
  baseUrl,
  baseHost: new URL(baseUrl).hostname,
  tokenPepper: process.env.SCHAFFA_TOKEN_PEPPER || "",
  bootstrapToken: process.env.SCHAFFA_BOOTSTRAP_TOKEN || "",
  shooBaseUrl,
  shooIssuer: readBaseUrl("SHOO_ISSUER", shooBaseUrl),
  userSessionTtlHours: boundedInteger("USER_SESSION_TTL_HOURS", 168, 1, 720),
  maxPageBytes: positiveInteger("MAX_PAGE_BYTES", 2 * 1024 * 1024),
  maxFileBytes: positiveInteger("MAX_FILE_BYTES", 256 * 1024 * 1024),
  maxImageInputBytes: positiveInteger("MAX_IMAGE_INPUT_BYTES", 32 * 1024 * 1024),
  maxStorageBytes: positiveInteger("MAX_STORAGE_BYTES", 20 * 1024 * 1024 * 1024),
  maxAnonymousStorageBytes: positiveInteger("MAX_ANONYMOUS_STORAGE_BYTES", 512 * 1024 * 1024),
  maxAnonymousPages: positiveInteger("MAX_ANONYMOUS_PAGES", 5000),
  maxPageVersions: boundedInteger("MAX_PAGE_VERSIONS", 25, 1, 1000),
  imageMaxInputPixels: positiveInteger("IMAGE_MAX_INPUT_PIXELS", 40_000_000),
  imageMaxEdge: boundedInteger("IMAGE_MAX_EDGE", 2560, 320, 8192),
  imageWebpQuality: boundedInteger("IMAGE_WEBP_QUALITY", 82, 40, 100),
  imageCleanConcurrency: boundedInteger("IMAGE_CLEAN_CONCURRENCY", 2, 1, 16),
  maxPublishedImageBytes: positiveInteger("MAX_PUBLISHED_IMAGE_BYTES", 8 * 1024 * 1024),
  anonymousPageTtlSeconds: boundedInteger("ANONYMOUS_PAGE_TTL_SECONDS", 3600, 300, 86400),
  anonymousPageRetentionDays: boundedInteger("ANONYMOUS_PAGE_RETENTION_DAYS", 30, 1, 365),
  anonymousUploadsPerHour: boundedInteger("ANONYMOUS_UPLOADS_PER_HOUR", 20, 1, 1000),
  authenticatedUploadsPerHour: boundedInteger("AUTHENTICATED_UPLOADS_PER_HOUR", 120, 1, 10_000),
  userLoginsPerHour: boundedInteger("USER_LOGINS_PER_HOUR", 60, 1, 1000),
  trustedProxyHops: boundedInteger("TRUST_PROXY_HOPS", 1, 1, 10),
  clamavHost: process.env.CLAMAV_HOST || "",
  clamavPort: boundedInteger("CLAMAV_PORT", 3310, 1, 65535),
  clamavTimeoutMs: boundedInteger("CLAMAV_TIMEOUT_MS", 15_000, 1000, 120_000),
  logLevel: process.env.LOG_LEVEL || "info",
  cookieSecure: new URL(baseUrl).protocol === "https:",
};

export type Config = typeof config;
