import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const output = process.env.STATIC_REPORT_PATH;
if (!output) throw new Error("Missing STATIC_REPORT_PATH");
const result = spawnSync(
  process.execPath,
  [
    resolve("node_modules/eslint/bin/eslint.js"),
    ".",
    "--format",
    "./scripts/opengrep/eslint-formatter.mjs",
    "--output-file",
    output,
  ],
  { encoding: "utf8", timeout: 600000, maxBuffer: 1024 * 1024 },
);
if (result.error || result.status === null || result.status > 1) {
  process.stderr.write("Type-aware analysis failed to run. No clean result.\n");
  process.exit(1);
}
const files = JSON.parse(readFileSync(output, "utf8"));
const messages = files.flatMap((f) => f.messages);
const fatal = messages.filter((m) => m.fatal).length;
const summary = `### Type-aware static analysis\n\nFiles: ${files.length} · Findings: ${messages.length} · Parser failures: ${fatal}\n\nFindings are advisory. Every location and rule ID is in the type-aware-static-analysis artifact.\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.stdout.write(summary);
if (fatal) process.exitCode = 1;
