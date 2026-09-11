import { type Diagnostic, safePath, safeRule } from "./model.ts";

const CATEGORIES: Record<string, Diagnostic["kind"]> = {
  PartialParsing: "parser",
  "Syntax error": "parser",
  "Other syntax error": "parser",
  LexicalError: "parser",
  Timeout: "timeout",
  "Out of memory": "memory",
};

// Raw messages, snippets, metavariables and nested type payloads never leave the scanner.
export function diagnostics(errors: unknown[]): Diagnostic[] {
  return errors.slice(0, 100).map((value) => {
    const e = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const rawType = Array.isArray(e.type) ? e.type[0] : e.type;
    const kind =
      typeof rawType === "string" && Object.hasOwn(CATEGORIES, rawType)
        ? (CATEGORIES[rawType] ?? "engine")
        : "engine";
    const result: Diagnostic = { kind };
    const spans = Array.isArray(e.spans) ? e.spans : [];
    const span = spans[0];
    const path = typeof e.path === "string" ? e.path.replace(/^\.\//, "") : span?.file;
    if (safePath(path)) result.path = path;
    if (safeRule(e.rule_id)) result.rule = e.rule_id;
    const line = span?.start?.line;
    if (result.path && Number.isSafeInteger(line) && line > 0) result.line = line;
    return result;
  });
}
