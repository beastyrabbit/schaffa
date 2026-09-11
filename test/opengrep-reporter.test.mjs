import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const reporter = fileURLToPath(new URL("../scripts/opengrep/report.ts", import.meta.url));
const model = new URL("../scripts/opengrep/model.ts", import.meta.url).href;
function run(scenario) {
  const root = mkdtempSync(join(tmpdir(), "opengrep-reporter-"));
  try {
    const report = {
      schema: 1,
      repository: "beastyrabbit/private-fixture",
      runId: "1",
      attempt: "1",
      head: "a".repeat(40),
      base: "b".repeat(40),
      mergeBase: "c".repeat(40),
      tooling: "d".repeat(40),
      profile: "all",
      engine: "1.30.0",
      status: "complete",
      files: 1,
      errorCount: 0,
      seconds: 1,
      findings:
        scenario === "fix"
          ? []
          : [{ rule: "homelab.web.eval", path: "app.js", line: 1, severity: "WARNING" }],
    };
    if (scenario === "wrong-repo") report.repository = "elsewhere/other";
    if (scenario === "rerun") report.attempt = "2";
    if (scenario === "incomplete") {
      report.status = "incomplete";
      report.errorCount = 1;
    }
    if (scenario === "audit-only")
      report.findings = [{ rule: "raptor-bad-words", path: "notes.md", line: 1, severity: "INFO" }];
    if (scenario !== "missing") writeFileSync(join(root, "report.json"), JSON.stringify(report));
    const stub = `
      import { writeFileSync } from 'node:fs';
      import { SUMMARY_MARKER } from ${JSON.stringify(model)};
      const writes=[]; const scenario=${JSON.stringify(scenario)};
      globalThis.fetch=async (url,options={})=>{
        const path=new URL(url).pathname;
        if(options.method && options.method!=='GET') {
          const body=JSON.parse(options.body); writes.push({path,method:options.method,body});
          return new Response('{}',{status:scenario==='publication-error' ? 403 : 200});
        }
        let body;
        if(path.endsWith('/pulls/2')) body={state:'open',user:{login:'beastyrabbit'},head:{sha:scenario==='stale'?'f'.repeat(40):'a'.repeat(40),repo:{full_name:'beastyrabbit/private-fixture'}},base:{sha:'b'.repeat(40),repo:{full_name:'beastyrabbit/private-fixture'}}};
        else if(path.startsWith('/users/')) body={id:42,login:'github-actions[bot]',type:'Bot'};
        else if(path.endsWith('/check-runs/123')) body={head_sha:'a'.repeat(40),name:'OpenGrep / report',external_id:'opengrep-1-1'};
        else if(path.endsWith('/issues/2/comments')) body=[{id:1,user:{id:99},body:SUMMARY_MARKER},...(scenario==='first'?[]:[{id:2,user:{id:42},body:SUMMARY_MARKER}])];
        else throw new Error('Unexpected request');
        return new Response(JSON.stringify(body),{status:200});
      };
      await import(${JSON.stringify(reporter)});
      writeFileSync(${JSON.stringify(join(root, "writes.json"))},JSON.stringify(writes));
    `;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", stub],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GH_TOKEN: "test-not-a-credential",
          GITHUB_REPOSITORY: "beastyrabbit/private-fixture",
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: scenario === "rerun" ? "2" : "1",
          PR_NUMBER: "2",
          SCAN_HEAD: "a".repeat(40),
          SCAN_BASE: "b".repeat(40),
          TOOLING_SHA: "d".repeat(40),
          CHECK_RUN_ID: ["existing-check", "rerun"].includes(scenario) ? "123" : "",
          CHECK_RUN_ATTEMPT: "1",
          REPORT_PATH: join(root, "report.json"),
        },
      },
    );
    return {
      status: result.status,
      writes: JSON.parse(readFileSync(join(root, "writes.json"), "utf8")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("reporter updates only its summary and places a neutral finding check on the PR head", () => {
  const r = run("finding");
  assert.equal(r.status, 0);
  assert.ok(r.writes.some((w) => w.path.endsWith("/issues/comments/2")));
  assert.ok(!r.writes.some((w) => w.path.endsWith("/issues/comments/1")));
  assert.equal(r.writes.length, 2);
  assert.ok(!r.writes.some((w) => w.path.includes("/pulls/")));
  const check = r.writes.find((w) => w.path.endsWith("/check-runs")).body;
  assert.equal(check.head_sha, "a".repeat(40));
  assert.equal(check.conclusion, "neutral");
});
test("first scans create one summary and fixes update the same summary", () => {
  const first = run("first");
  assert.equal(first.status, 0);
  assert.equal(first.writes.length, 2);
  assert.equal(first.writes[0].method, "POST");
  assert.ok(first.writes[0].path.endsWith("/issues/2/comments"));
  const fixed = run("fix");
  assert.equal(fixed.writes.length, 2);
  assert.ok(fixed.writes[0].path.endsWith("/issues/comments/2"));
  assert.equal(fixed.writes.find((w) => w.path.endsWith("/check-runs")).body.conclusion, "success");
});
test("incomplete scans publish their summary and a failing check", () => {
  const r = run("incomplete");
  assert.equal(r.status, 1);
  assert.equal(r.writes.length, 2);
  assert.match(r.writes[0].body.body, /Analysis incomplete/);
  assert.equal(r.writes[1].body.conclusion, "failure");
});
test("stale commits and wrong repositories never receive comments; publication errors fail", () => {
  for (const scenario of ["stale", "wrong-repo"]) {
    const r = run(scenario);
    assert.equal(r.status, 1);
    assert.ok(
      r.writes.every((w) => w.path.endsWith("/check-runs") && w.body.conclusion === "failure"),
    );
  }
  assert.equal(run("publication-error").status, 1);
});

test("missing report invalidates old summary and audit-only results remain clean", () => {
  const missing = run("missing");
  assert.equal(missing.status, 1);
  assert.match(missing.writes[0].body.body, /Analysis unavailable/);
  const audit = run("audit-only");
  assert.equal(audit.status, 0);
  assert.match(audit.writes[0].body.body, /Findings: 0/);
  assert.equal(audit.writes[1].body.conclusion, "success");
});
test("final report completes the same check created at scan start", () => {
  const r = run("existing-check");
  assert.equal(r.status, 0);
  assert.equal(r.writes[1].path.endsWith("/check-runs/123"), true);
  assert.equal(r.writes[1].method, "PATCH");
  assert.equal(r.writes[1].body.status, "completed");
});

test("failed-job rerun validates attempt-two report and completes attempt-one check", () => {
  const r = run("rerun");
  assert.equal(r.status, 0);
  assert.equal(r.writes[1].path.endsWith("/check-runs/123"), true);
  assert.equal(r.writes[1].body.external_id, "opengrep-1-1");
  assert.equal(r.writes[1].body.conclusion, "neutral");
});
