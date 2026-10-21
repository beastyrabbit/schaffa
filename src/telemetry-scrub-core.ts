// Scan each side of an @ once rather than retrying an email regex at every character.
function emailMatchEnd(value: string, at: number): number {
  if (value[at + 1] === "[") {
    const literal = /\[[^\]]{1,64}\]/y;
    literal.lastIndex = at + 1;
    const match = literal.exec(value);
    return match ? at + 1 + match[0].length : 0;
  }
  const domain = /[\p{L}\p{M}\p{N}.+_-]*/uy;
  domain.lastIndex = at + 1;
  const text = domain.exec(value)?.[0] || "";
  let end = 0;
  for (const suffix of text.matchAll(/\.(?:xn--[\p{L}\p{N}-]+|[\p{L}\p{M}]{2,})/giu)) {
    if (suffix.index > 0) end = at + 1 + suffix.index + suffix[0].length;
  }
  if (end && value[end] === ".") end++;
  return end;
}

function emailLocalStart(value: string, at: number, cursor: number): number {
  let start = at;
  let quoted = false;
  while (start > cursor) {
    const character = value[start - 1] || "";
    if (!quoted && /[\s<(,;:]/.test(character)) break;
    start--;
    if (character !== '"') continue;
    let backslashes = 0;
    while (start > cursor && value[start - 1] === "\\") {
      start--;
      backslashes++;
    }
    if (backslashes % 2 === 0) quoted = !quoted;
  }
  return start;
}

function scrubEmails(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/@/g)) {
    if (match.index < cursor) continue;
    // Validate first: invalid @ sequences must not repeatedly scan the local token.
    const end = emailMatchEnd(value, match.index);
    if (!end) continue;
    const start = emailLocalStart(value, match.index, cursor);
    if (start === match.index) continue;
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

export interface TelemetryPage {
  origin: string;
  pathname: string;
  pagePath: string;
}

function safeUrl(value: string, page: TelemetryPage): string {
  try {
    const url = new URL(value, page.origin);
    if (url.origin === page.origin && url.pathname === page.pathname) return page.pagePath;
  } catch {}
  return "/[redacted]";
}

function scrubUrlField(key: string, value: unknown, page: TelemetryPage): unknown {
  if (typeof value !== "string") return value;
  if (key === "transaction") return page.pagePath;
  if (/^(url|from|to|http\.url|url\.full|url\.path)$/.test(key)) return safeUrl(value, page);
  if (key === "description") {
    const url = value.replace(/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+/, "");
    if (/^(?:https?:\/\/|\/)/.test(url)) return safeUrl(url, page);
  }
  return value;
}

export function scrubTelemetry<T>(value: T, page?: TelemetryPage): T {
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
            : [[key, visit(page ? scrubUrlField(key, entry, page) : entry, depth + 1)]],
        ),
      );
    }
    return item;
  };
  return visit(value, 0) as T;
}
