import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diagnostics } from "../scripts/opengrep/diagnostics.ts";
import {
  escapeMarkdown,
  summary,
  trustedPullAuthor,
  validateReport,
} from "../scripts/opengrep/model.ts";
import {
  MAX_TARGET_BYTES,
  scanExcludes,
  scanTargets,
  vendorExcludes,
} from "../scripts/opengrep/policy.ts";

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
  assert.equal(body.match(/\| INFO \| audit/g).length, 1);
  assert.ok(body.indexOf("| ERROR | security") < body.indexOf("| INFO | audit"));
  assert.ok(body.includes(`/blob/${r.head}/src/code.ts#L2`));
  assert.deepEqual(r, original);
});

test("word search stays in the artifact but is absent from primary findings and examples", () => {
  const r = report();
  r.findings.push(
    ...Array.from({ length: 1000 }, (_, i) => ({
      rule: "raptor-bad-words",
      path: "notes.md",
      line: i + 1,
      severity: "INFO",
    })),
  );
  const body = summary(validateReport(r), "https://github.com/owner/repo/actions/runs/1");
  assert.match(body, /Findings: 1 ·/);
  assert.match(body, /Word-search audit matches: 1000/);
  assert.ok(!body.includes("raptor-bad-words"));
  assert.ok(!body.includes("notes.md"));
  assert.equal(r.findings.length, 1001);
});

test("safe diagnostics strip arbitrary messages and nested parser payloads", () => {
  const marker = "source-private-marker";
  const raw = [
    {
      type: ["PartialParsing", [{ snippet: marker }]],
      path: "./src/a.ts",
      message: marker,
      spans: [{ file: "src/a.ts", start: { line: 42 }, source: marker }],
    },
    { type: "Timeout", path: "src/db.py", rule_id: "sql-rule", message: marker },
    { type: marker, path: "../outside", rule_id: `${marker}\n` },
  ];
  const safe = diagnostics(raw);
  assert.deepEqual(safe, [
    { kind: "parser", path: "src/a.ts", line: 42 },
    { kind: "timeout", path: "src/db.py", rule: "sql-rule" },
    { kind: "engine" },
  ]);
  assert.ok(!JSON.stringify(safe).includes(marker));
  const r = { ...report(), status: "incomplete", errorCount: 3, diagnostics: safe };
  assert.match(
    summary(validateReport(r), "https://github.com/owner/repo/actions/runs/1"),
    /src\/a\.ts#L42/,
  );
  assert.throws(() => validateReport({ ...r, diagnostics: [{ kind: "parser", message: marker }] }));
  assert.throws(() =>
    validateReport({ ...r, diagnostics: [{ kind: "parser", path: "../outside" }] }),
  );
  assert.equal(diagnostics(Array(1000).fill({ type: "Timeout" })).length, 100);
});

test("trusted exclusions are restricted to PDF data and diagnosed vendor bundles", () => {
  assert.ok(scanExcludes().includes("*.pdf"));
  assert.ok(vendorExcludes("beastyrabbit/beasty_printer_hub").includes("tools/jshint.js"));
  assert.ok(!vendorExcludes("beastyrabbit/another-repo").includes("tools/jshint.js"));
  assert.ok(!vendorExcludes("SKYWAY-GmbH/helma").includes("src/helma/store.py"));
  assert.ok(!scanExcludes().includes("*.min.js"));
});

test("explicit targets preserve PDF, size, symlink and directory limits without excluding nested source", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrep-targets-"));
  try {
    mkdirSync(join(root, "tools"));
    mkdirSync(join(root, "src/tools"), { recursive: true });
    mkdirSync(join(root, "node_modules"));
    for (const path of ["tools/jshint.js", "src/tools/jshint.js", "book.pdf", "large.js", "app.js"])
      writeFileSync(join(root, path), "fixture");
    truncateSync(join(root, "large.js"), MAX_TARGET_BYTES + 1);
    symlinkSync("app.js", join(root, "link.js"));
    assert.deepEqual(scanTargets(root, "beastyrabbit/beasty_printer_hub"), ["./app.js", "./src"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
