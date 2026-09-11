import { AUDIT_RULES, scanExcludes, vendorExcludes } from "./policy.ts";

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
  diagnostics?: Diagnostic[];
}

export interface Diagnostic {
  kind: "parser" | "timeout" | "memory" | "engine" | "setup";
  path?: string;
  line?: number;
  rule?: string;
  stage?: string;
}

export function safePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith("/") &&
    ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === "\\") &&
    !path.split("/").some((p) => p === ".." || p === "." || p === ".git" || p === "")
  );
}
export function safeRule(rule: unknown): rule is string {
  return typeof rule === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,240}$/.test(rule);
}
export function primaryFindings(r: Report): Finding[] {
  return r.findings.filter((f) => !AUDIT_RULES.has(f.rule));
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
    (r.status === "incomplete" && r.errorCount === 0) ||
    (r.status === "not-applicable" &&
      (r.errorCount !== 0 || r.files !== 0 || r.findings.length !== 0))
  )
    throw new Error("Invalid report metadata");
  for (const f of r.findings) {
    if (
      !f ||
      !safeRule(f.rule) ||
      !safePath(f.path) ||
      !Number.isSafeInteger(f.line) ||
      f.line < 1 ||
      !["ERROR", "WARNING", "INFO"].includes(f.severity)
    )
      throw new Error("Invalid finding");
  }
  if (r.diagnostics !== undefined) {
    if (
      !Array.isArray(r.diagnostics) ||
      r.diagnostics.length > 100 ||
      r.diagnostics.length > r.errorCount
    )
      throw new Error("Invalid diagnostics");
    for (const d of r.diagnostics) {
      if (
        !d ||
        !["parser", "timeout", "memory", "engine", "setup"].includes(d.kind) ||
        Object.keys(d).some((k) => !["kind", "path", "line", "rule", "stage"].includes(k)) ||
        (d.path !== undefined && !safePath(d.path)) ||
        (d.line !== undefined && (!d.path || !Number.isSafeInteger(d.line) || d.line < 1)) ||
        (d.rule !== undefined && !safeRule(d.rule)) ||
        (d.stage !== undefined && !/^[a-z-]{1,64}$/.test(d.stage))
      )
        throw new Error("Invalid diagnostic");
    }
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

export function summary(r: Report, runUrl: string): string {
  const state =
    r.status === "complete"
      ? "Scan complete"
      : r.status === "not-applicable"
        ? "No applicable files in this scan. This is not a clean bill of health for other languages."
        : "Analysis incomplete; no clean result";
  const severityOrder = { ERROR: 0, WARNING: 1, INFO: 2 };
  const groups = new Map<string, { rule: string; severity: Finding["severity"]; count: number }>();
  const counts = { ERROR: 0, WARNING: 0, INFO: 0 };
  const primary = primaryFindings(r);
  for (const finding of primary) {
    counts[finding.severity]++;
    const group = groups.get(finding.rule);
    if (group) {
      group.count++;
      if (severityOrder[finding.severity] < severityOrder[group.severity])
        group.severity = finding.severity;
    } else groups.set(finding.rule, { rule: finding.rule, severity: finding.severity, count: 1 });
  }
  const rows = [...groups.values()]
    .sort(
      (a, b) =>
        severityOrder[a.severity] - severityOrder[b.severity] || a.rule.localeCompare(b.rule),
    )
    .slice(0, 20)
    .map((g) => `| ${g.severity} | ${escapeMarkdown(g.rule)} | ${g.count} |`);
  const location = (path: string, line?: number): string => {
    const url = `https://github.com/${r.repository}/blob/${r.head}/${path.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;
    const label = `${path.length > 90 ? `…${path.slice(-89)}` : path}${line ? `:${line}` : ""}`;
    if (url.length > 2048) return `${escapeMarkdown(label)} (see artifact)`;
    return `[${escapeMarkdown(label)}](${url.replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"))})`;
  };
  const examples = [...groups.values()]
    .sort(
      (a, b) =>
        severityOrder[a.severity] - severityOrder[b.severity] || a.rule.localeCompare(b.rule),
    )
    .slice(0, 5)
    .map((g) => primary.find((f) => f.rule === g.rule))
    .filter((f): f is Finding => Boolean(f))
    .map((f) => `- ${escapeMarkdown(f.rule)}: ${location(f.path, f.line)}`);
  const errors = (r.diagnostics ?? [])
    .slice(0, 5)
    .map(
      (d) =>
        `- ${d.kind}${d.path ? `: ${location(d.path, d.line)}` : ""}${d.rule ? ` · ${escapeMarkdown(d.rule)}` : ""}${d.stage ? ` · ${d.stage}` : ""}`,
    );
  return [
    SUMMARY_MARKER,
    "### OpenGrep",
    state,
    "",
    `Commit: ${r.head.slice(0, 12)} · Engine: ${r.engine} · Rules: ${r.tooling.slice(0, 12)} · Profile: ${r.profile}`,
    `Files scanned: ${r.files} · Findings: ${primary.length} · Technical errors: ${r.errorCount}`,
    `Word-search audit matches: ${r.findings.length - primary.length}, retained in the JSON artifact and excluded from the finding total above.`,
    `Severity: ${counts.ERROR} ERROR · ${counts.WARNING} WARNING · ${counts.INFO} INFO`,
    "Reporting only. Findings do not enforce a merge restriction.",
    "",
    ...(rows.length ? ["| Severity | Rule | Findings |", "| --- | --- | ---: |", ...rows] : []),
    ...(groups.size > 20 ? [`${groups.size - 20} more rule groups in the report artifact.`] : []),
    ...(examples.length
      ? ["", "Example locations, at most five rule groups:", "", ...examples]
      : []),
    ...(errors.length ? ["", "Analysis gaps:", "", ...errors] : []),
    ...(r.errorCount > errors.length
      ? [
          `${r.errorCount - errors.length} further errors; up to 100 safe diagnostics are retained in the artifact.`,
        ]
      : []),
    "",
    `Scan scope excludes PDFs, ${scanExcludes().length - 2} directory patterns and ${vendorExcludes(r.repository).length} exact vendor paths. Excluded files are not analyzed; see the trusted policy.`,
    "The complete JSON artifact includes every finding with its rule, file and line. No inline comments are posted.",
    `[Full report and run](${runUrl})`,
  ].join("\n");
}
