import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGINE_SHA256,
  ENGINE_VERSION,
  PROFILES,
  type Report,
  SHA,
  validateReport,
} from "./model.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const root = required("SCAN_ROOT");
const output = required("REPORT_PATH");
const profile = required("SCAN_PROFILE");
const head = required("SCAN_HEAD");
const base = required("SCAN_BASE");
const tooling = required("TOOLING_SHA");
const profiles = profile.split(",");
if (
  ![head, base, tooling].every((v) => SHA.test(v)) ||
  !profiles.every((p) => PROFILES.some((v) => v === p))
) {
  throw new Error("Invalid scan inputs");
}
mkdirSync(dirname(output), { recursive: true });
const started = Date.now();
const report: Report = {
  schema: 1,
  repository: required("GITHUB_REPOSITORY"),
  runId: required("GITHUB_RUN_ID"),
  attempt: required("GITHUB_RUN_ATTEMPT"),
  head,
  base,
  mergeBase: base,
  tooling,
  profile,
  engine: ENGINE_VERSION,
  status: "incomplete",
  files: 0,
  errorCount: 1,
  seconds: 0,
  findings: [],
};

try {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (revision.status !== 0 || revision.stdout.trim() !== head) throw new Error("Wrong checkout");
  const merge = spawnSync("git", ["merge-base", head, base], { cwd: root, encoding: "utf8" });
  if (merge.status !== 0 || !SHA.test(merge.stdout.trim())) throw new Error("Missing merge base");
  report.mergeBase = merge.stdout.trim();
  const binary = process.env.OPENGREP_BINARY ?? resolve(required("RUNNER_TEMP"), "opengrep");
  if (!process.env.OPENGREP_BINARY) {
    const response = await fetch(
      `https://github.com/opengrep/opengrep/releases/download/v${ENGINE_VERSION}/opengrep_manylinux_x86`,
      {
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!response.ok) throw new Error("Engine download failed");
    writeFileSync(binary, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash("sha256").update(readFileSync(binary)).digest("hex") !== ENGINE_SHA256) {
    throw new Error("Engine checksum mismatch");
  }
  chmodSync(binary, 0o700);
  const vendor = fileURLToPath(new URL("../../.github/opengrep/vendor/", import.meta.url));
  const manifest = JSON.parse(readFileSync(resolve(vendor, "manifest.json"), "utf8")) as {
    profiles: Record<string, string[]>;
    sha256: [string, string][];
  };
  const selected = profiles.includes("all")
    ? Object.keys(manifest.profiles)
    : [...new Set([...profiles, "config"])];
  const ruleFiles = new Set(selected.flatMap((p) => manifest.profiles[p] ?? []));
  const integrity = new Map(manifest.sha256);
  if (!ruleFiles.size) throw new Error("No rules selected");
  const rules = [...ruleFiles].sort().flatMap((relative) => {
    if (relative.includes("..") || relative.startsWith("/")) throw new Error("Invalid rule path");
    const path = resolve(vendor, relative);
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== integrity.get(relative)) {
      throw new Error("Rule integrity mismatch");
    }
    return ["--config", path];
  });
  for (const p of ["web", "python", "go"]) {
    if (profiles.includes("all") || profiles.includes(p)) {
      rules.push(
        "--config",
        fileURLToPath(new URL(`../../.github/opengrep/rules/${p}.yaml`, import.meta.url)),
      );
    }
  }
  const args = [
    "scan",
    ...rules,
    "--json",
    "--quiet",
    "--strict",
    "--taint-intrafile",
    "--disable-version-check",
    "--disable-nosem",
    "--no-git-ignore",
    "--x-ignore-semgrepignore-files",
    "--no-rewrite-rule-ids",
    "--jobs",
    "3",
    "--max-memory",
    "2000",
    "--timeout",
    "20",
    "--timeout-threshold",
    "1",
    "--max-target-bytes",
    "20000000",
    "--exclude",
    ".git",
    "--exclude",
    "node_modules",
    "--exclude",
    ".venv",
    "--exclude",
    "dist",
    "--exclude",
    "build",
    "--exclude",
    "coverage",
    "--exclude",
    ".github/opengrep/vendor",
  ];
  if (process.env.SCAN_MODE === "pr") args.push("--baseline-commit", report.mergeBase);
  args.push(".");
  const scan = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 1800000,
    env: { ...process.env, SEMGREP_SEND_METRICS: "off" },
  });
  // Raw output stays in memory: it can contain source code and must never enter CI logs/artifacts.
  if (scan.error) throw new Error("Scanner failed");
  const raw = JSON.parse(scan.stdout);
  if (
    !Array.isArray(raw.errors) ||
    !Array.isArray(raw.results) ||
    !Array.isArray(raw.paths?.scanned)
  ) {
    throw new Error("Invalid scanner output");
  }
  report.files = raw.paths.scanned.length;
  report.errorCount = raw.errors.length;
  if (scan.status !== 0 && report.errorCount === 0) report.errorCount = 1;
  report.findings = raw.results.map(
    (f: {
      check_id: string;
      path: string;
      start: { line: number };
      extra: { severity: "ERROR" | "WARNING" | "INFO" };
    }) => ({
      rule: f.check_id,
      path: f.path.replace(/^\.\//, ""),
      line: f.start.line,
      severity: f.extra.severity,
    }),
  );
  report.status =
    report.errorCount > 0 ? "incomplete" : report.files > 0 ? "complete" : "not-applicable";
  const priority = { ERROR: 0, WARNING: 1, INFO: 2 };
  report.findings.sort(
    (a, b) =>
      priority[a.severity] - priority[b.severity] ||
      a.rule.localeCompare(b.rule) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
  validateReport(report);
} catch {
  report.status = "incomplete";
  report.errorCount = Math.max(report.errorCount, 1);
  report.findings = [];
  process.stderr.write(
    "OpenGrep did not complete. Raw scanner output was withheld to protect source data.\n",
  );
} finally {
  report.seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
if (report.status === "incomplete") process.exitCode = 1;
