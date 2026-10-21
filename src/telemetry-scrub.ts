import { AppError } from "./errors.js";

// Scan each side of an @ once rather than retrying an email regex at every character.
function emailMatchEnd(value: string, at: number): number {
  const domain = /[\p{L}\p{N}.+_-]*/uy;
  domain.lastIndex = at + 1;
  const text = domain.exec(value)?.[0] || "";
  let end = 0;
  for (const suffix of text.matchAll(/\.\p{L}{2,}/gu)) {
    if (suffix.index > 0) end = at + 1 + suffix.index + suffix[0].length;
  }
  return end;
}

function emailLocalStart(value: string, at: number, cursor: number): number {
  let start = at;
  while (start > cursor) {
    const width = (value.codePointAt(start - 2) || 0) > 0xffff ? 2 : 1;
    if (!/[\p{L}\p{N}.+_-]/u.test(value.slice(start - width, start))) break;
    start -= width;
  }
  return start;
}

function scrubEmails(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/@/g)) {
    const start = emailLocalStart(value, match.index, cursor);
    if (start === match.index) continue;
    const end = emailMatchEnd(value, match.index);
    if (!end) continue;
    parts.push(value.slice(cursor, start), "[email]");
    cursor = end;
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

export function scrubText(value: string): string {
  return (
    scrubEmails(
      value
        .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
        .replace(/\b(?:sfa|sus)_[\w-]+/g, "[redacted]")
        .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, "[redacted]"),
    )
      .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => url.split(/[?#]/, 1)[0] || "")
      // Matching paths without a query too avoids retrying every slash on failure.
      .replace(/\/[\w/%.:@-]+(?:[?#][^\s"'<>]*)?/g, (url) => url.split(/[?#]/, 1)[0] || "")
  );
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
export function shouldReportServerError(error: unknown): boolean {
  if (error && typeof error === "object" && "statusCode" in error && Number(error.statusCode) < 500)
    return false;
  return !(
    error instanceof AppError &&
    ["interactive_disabled", "storage_quota", "scanner_unavailable", "writes_locked"].includes(
      error.code,
    )
  );
}
