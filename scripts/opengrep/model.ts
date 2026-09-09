import { createHash } from "node:crypto";

export const ENGINE_VERSION = "1.30.0";
export const ENGINE_SHA256 = "35779bdd72e92129c8df2a77f0c55e8c08356801ea92591ef32108d6b28d564c";
export const PROFILES = [
  "all",
  "web",
  "python",
  "go",
  "c-cpp",
  "dotnet",
  "jvm",
  "swift",
  "ruby",
  "rust",
  "php",
  "config",
] as const;
export const ALLOWED_AUTHORS = ["beastyrabbit", "renovate[bot]", "dependabot[bot]"];
export function trustedPullAuthor(
  repository: string,
  login: string,
  association?: string,
): boolean {
  const owner = repository.split("/")[0];
  if (owner !== "beastyrabbit" && owner !== "SKYWAY-GmbH") return false;
  return (
    ALLOWED_AUTHORS.includes(login) ||
    (owner === "SKYWAY-GmbH" && ["OWNER", "MEMBER", "COLLABORATOR"].includes(association ?? ""))
  );
}
export const SUMMARY_MARKER = "<!-- homelab-opengrep-summary-v1 -->";
export const SHA = /^[a-f0-9]{40}$/;

export interface Finding {
  rule: string;
  path: string;
  line: number;
  severity: "ERROR" | "WARNING" | "INFO";
}

export interface Report {
  schema: 1;
  repository: string;
  runId: string;
  attempt: string;
  head: string;
  base: string;
  mergeBase: string;
  tooling: string;
  profile: string;
  engine: string;
  status: "complete" | "incomplete" | "not-applicable";
  files: number;
  errorCount: number;
  seconds: number;
  findings: Finding[];
}

export function validateReport(value: unknown): Report {
  if (!value || typeof value !== "object") throw new Error("Missing report");
  const r = value as Report;
  if (
    r.schema !== 1 ||
    !/^[\w.-]+\/[\w.-]+$/.test(r.repository) ||
    !/^\d+$/.test(r.runId) ||
    !/^\d+$/.test(r.attempt) ||
    ![r.head, r.base, r.mergeBase, r.tooling].every((v) => typeof v === "string" && SHA.test(v)) ||
    typeof r.profile !== "string" ||
    !r.profile.split(",").every((p) => PROFILES.some((v) => v === p)) ||
    r.engine !== ENGINE_VERSION ||
    !["complete", "incomplete", "not-applicable"].includes(r.status) ||
    ![r.files, r.errorCount].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    !Number.isFinite(r.seconds) ||
    r.seconds < 0 ||
    !Array.isArray(r.findings) ||
    r.findings.length > 100000 ||
    (r.status === "complete" && (r.errorCount !== 0 || r.files === 0)) ||
    (r.status === "not-applicable" &&
      (r.errorCount !== 0 || r.files !== 0 || r.findings.length !== 0))
  )
    throw new Error("Invalid report metadata");
  for (const f of r.findings) {
    if (
      !f ||
      typeof f.rule !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,240}$/.test(f.rule) ||
      typeof f.path !== "string" ||
      f.path.length > 1024 ||
      f.path.startsWith("/") ||
      [...f.path].some((c) => c.charCodeAt(0) < 32 || c === "\\") ||
      f.path.split("/").some((p) => p === ".." || p === ".git" || p === "") ||
      !Number.isSafeInteger(f.line) ||
      f.line < 1 ||
      !["ERROR", "WARNING", "INFO"].includes(f.severity)
    )
      throw new Error("Invalid finding");
  }
  return r;
}

export function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}

export function findingMarker(f: Finding): string {
  const id = createHash("sha256")
    .update(JSON.stringify([f.rule, f.path, f.line]))
    .digest("hex");
  return `<!-- homelab-opengrep-finding:${id} -->`;
}

export function addedLines(patch: string): Set<number> {
  const result = new Set<number>();
  let line = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk?.[1]) {
      line = Number(hunk[1]);
      inHunk = true;
    } else if (inHunk && text.startsWith("+")) {
      result.add(line);
      line++;
    } else if (inHunk && text.startsWith(" ")) line++;
  }
  return result;
}

export function summary(r: Report, runUrl: string): string {
  const state =
    r.status === "complete"
      ? "Scan complete"
      : r.status === "not-applicable"
        ? "No applicable files in this scan. This is not a clean bill of health for other languages."
        : "Analysis incomplete; no clean result";
  const rows = r.findings
    .slice(0, 50)
    .map((f) => `- ${f.severity} ${escapeMarkdown(f.rule)}: ${escapeMarkdown(f.path)}:${f.line}`);
  return [
    SUMMARY_MARKER,
    "### OpenGrep",
    state,
    "",
    `Commit: ${r.head.slice(0, 12)} · Engine: ${r.engine} · Rules: ${r.tooling.slice(0, 12)} · Profile: ${r.profile}`,
    `Files scanned: ${r.files} · New findings: ${r.findings.length} · Technical errors: ${r.errorCount}`,
    "Reporting only. Findings do not enforce a merge restriction.",
    "",
    ...rows,
    ...(r.findings.length > 50
      ? [`${r.findings.length - 50} more findings in the report artifact.`]
      : []),
    "",
    `[Full report and run](${runUrl})`,
  ].join("\n");
}
