import { AppError } from "./errors.js";

export function scrubText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sfa|sus)_[\w-]+/g, "[redacted]")
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, "[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => url.split(/[?#]/, 1)[0] || "")
    .replace(/(\/[\w/%.:@-]+)[?#][^\s"'<>]*/g, "$1");
}

export function scrubTelemetry<T>(value: T): T {
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 12) return "[truncated]";
    if (typeof item === "string") return scrubText(item);
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).flatMap(([key, entry]) =>
          /^(user|ip_address|email|authorization|cookie|set-cookie|password|token|data|body|query_string|query|search|hash)$/i.test(
            key,
          )
            ? []
            : [[key, visit(entry, depth + 1)]],
        ),
      );
    }
    return item;
  };
  return visit(value, 0) as T;
}
export function shouldReportServerError(error: Error): boolean {
  if ("statusCode" in error && Number(error.statusCode) < 500) return false;
  return !(
    error instanceof AppError &&
    ["interactive_disabled", "storage_quota", "scanner_unavailable", "writes_locked"].includes(
      error.code,
    )
  );
}
