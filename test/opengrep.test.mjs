import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeMarkdown,
  summary,
  trustedPullAuthor,
  validateReport,
} from "../scripts/opengrep/model.ts";

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

test("organization authors require current membership or repository collaboration", () => {
  assert.ok(trustedPullAuthor("SKYWAY-GmbH/project", "colleague", "MEMBER"));
  assert.ok(trustedPullAuthor("SKYWAY-GmbH/project", "colleague", "COLLABORATOR"));
  assert.ok(trustedPullAuthor("SKYWAY-GmbH/project", "dependabot[bot]"));
  for (const association of [undefined, "NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"]) {
    assert.ok(!trustedPullAuthor("SKYWAY-GmbH/project", "outsider", association));
  }
  assert.ok(!trustedPullAuthor("beastyrabbit/project", "colleague", "COLLABORATOR"));
  assert.ok(!trustedPullAuthor("another-org/project", "beastyrabbit", "OWNER"));
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

test("noisy findings become one rule row without losing artifact detail", () => {
  const r = report();
  r.findings = Array.from({ length: 195 }, (_, i) => ({
    rule: "audit.words",
    path: "src/code.ts",
    line: i + 1,
    severity: "INFO",
  }));
  r.findings.push({ rule: "security.ssrf", path: "src/code.ts", line: 2, severity: "ERROR" });
  const original = structuredClone(r);
  const body = summary(r, "https://github.com/owner/repo/actions/runs/1");
  assert.match(body, /INFO \| audit\\\.words \| 195/);
  assert.equal(body.match(/audit/g).length, 1);
  assert.ok(body.indexOf("security") < body.indexOf("audit"));
  assert.ok(!body.includes("src/code"));
  assert.deepEqual(r, original);
});

test("large summaries are bounded and incomplete scans remain explicit", () => {
  const r = report();
  r.status = "incomplete";
  r.errorCount = 1;
  r.findings = Array.from({ length: 100000 }, (_, i) => ({
    rule: `rule${i}`,
    path: "app.ts",
    line: 1,
    severity: "WARNING",
  }));
  const body = summary(validateReport(r), "https://github.com/owner/repo/actions/runs/1");
  assert.match(body, /Analysis incomplete; no clean result/);
  assert.match(body, /99980 more rule groups/);
  assert.ok(body.length < 10000);
});
