import assert from "node:assert/strict";
import test from "node:test";
import { addedLines, escapeMarkdown, summary, validateReport } from "../scripts/opengrep/model.ts";

const report = () => ({
  schema: 1,
  repository: "owner/private-repo",
  runId: "1",
  attempt: "1",
  head: "a".repeat(40),
  base: "b".repeat(40),
  mergeBase: "c".repeat(40),
  tooling: "d".repeat(40),
  profile: "web,python",
  engine: "1.30.0",
  status: "complete",
  files: 2,
  errorCount: 0,
  seconds: 1,
  findings: [{ rule: "homelab.web.eval", path: "src/code.ts", line: 12, severity: "WARNING" }],
});

test("report schema rejects traversal, malformed revisions and false clean results", () => {
  assert.equal(validateReport(report()).profile, "web,python");
  for (const path of [
    "../outside",
    "/etc/passwd",
    "src/../../outside",
    "a\\b",
    ".git/config",
    "bad\nname",
  ]) {
    assert.throws(() =>
      validateReport({ ...report(), findings: [{ ...report().findings[0], path }] }),
    );
  }
  for (const change of [
    { head: "main" },
    { files: 0 },
    { errorCount: 1 },
    { profile: "imaginary-language" },
    { status: "not-applicable" },
    { findings: null },
  ]) {
    assert.throws(() => validateReport({ ...report(), ...change }));
  }
});

test("missing language coverage is explicit, and paths cannot insert mentions or HTML", () => {
  const r = validateReport({ ...report(), status: "not-applicable", files: 0, findings: [] });
  assert.match(summary(r, "https://github.com/owner/repo/actions/runs/1"), /No applicable files/);
  const escaped = escapeMarkdown("<img>@someone `code` [link](https://bad.invalid)");
  assert.ok(!escaped.includes("<img>"));
  assert.ok(!escaped.includes("@someone"));
  assert.ok(escaped.includes("\\[link\\]"));
});

test("diff positions account for deletions, context and multiple hunks", () => {
  assert.deepEqual(
    [
      ...addedLines(
        "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context\n@@ -30,0 +31,2 @@\n+one\n+two",
      ),
    ],
    [11, 31, 32],
  );
});
