// Explicit local acceptance run: OPENGREP_BINARY=/path/to/verified/opengrep node --test this-file
// Never downloads tools, runs application code, contacts GitHub or calls an AI provider.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareEngine } from "./engine.ts";

const binary = process.env.OPENGREP_BINARY;
if (!binary) throw new Error("Set OPENGREP_BINARY to the verified local release binary");
const script = fileURLToPath(new URL("./scan.ts", import.meta.url));

// biome-ignore lint/style/noDoneCallback: t is node:test's TestContext, not a completion callback.
test("verified preinstalled engine is reused without network access", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network access");
  });
  await prepareEngine(binary);
});

test("real engine: baseline, intrafile flow, fix, ignores, mixed languages and parser errors", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrep-acceptance-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=OpenGrep Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  const scan = (base, profile = "web", mode = "pr") => {
    const output = join(root, "..", `${root.split("/").at(-1)}-report.json`);
    try {
      const result = spawnSync(process.execPath, ["--experimental-strip-types", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENGREP_BINARY: binary,
          SCAN_ROOT: root,
          REPORT_PATH: output,
          SCAN_PROFILE: profile,
          SCAN_MODE: mode,
          SCAN_HEAD: git("rev-parse", "HEAD"),
          SCAN_BASE: base,
          TOOLING_SHA: "a".repeat(40),
          GITHUB_REPOSITORY: "owner/fixture",
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "1",
        },
      });
      return { exit: result.status, report: JSON.parse(readFileSync(output, "utf8")) };
    } finally {
      rmSync(output, { force: true });
    }
  };
  try {
    git("init", "-q");
    writeFileSync(join(root, "existing.js"), "eval(existingValue);\n");
    const base = commit();
    writeFileSync(join(root, "new.js"), "eval(newValue); // nosemgrep\n");
    writeFileSync(join(root, ".semgrepignore"), "new.js\n");
    writeFileSync(join(root, ".gitignore"), "new.js\n");
    git("add", "-f", "new.js");
    commit();
    const finding = scan(base);
    assert.equal(finding.exit, 0);
    assert.equal(finding.report.status, "complete");
    assert.deepEqual([...new Set(finding.report.findings.map((f) => f.path))], ["new.js"]);

    writeFileSync(join(root, "new.js"), "const fixed = true;\n");
    git("add", "-f", "new.js");
    commit();
    assert.equal(scan(base).report.findings.length, 0);

    writeFileSync(
      join(root, "flow.ts"),
      "function helper(x: string) { return x; }\nfunction handle(request: any) { exec(helper(request.query.cmd)); }\n",
    );
    commit();
    assert.ok(scan(base).report.findings.some((f) => f.rule === "homelab.web.request-to-shell"));

    writeFileSync(
      join(root, "example.py"),
      "import subprocess\nsubprocess.run(command, shell=True)\n",
    );
    commit();
    const mixed = scan(base, "web,python");
    assert.ok(mixed.report.findings.some((f) => f.rule === "homelab.python.shell"));

    writeFileSync(
      join(root, "broken.ts"),
      'const popup = new Promise<import("pkg").Page | null>((resolve) =>\npage.once("popup", resolve),\n);\n',
    );
    commit();
    const broken = scan(base);
    assert.equal(broken.exit, 1);
    assert.equal(broken.report.status, "incomplete");
    assert.ok(broken.report.errorCount > 0);
    assert.ok(broken.report.diagnostics.some((d) => d.kind === "parser" && d.path === "broken.ts"));

    const noFiles = scan(git("rev-parse", "HEAD"), "go");
    assert.equal(noFiles.report.status, "not-applicable");

    const invalid = scan("f".repeat(40));
    assert.equal(invalid.exit, 1);
    assert.equal(invalid.report.status, "incomplete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real engine skips PDF data and exact vendor path while keeping nested own-source findings", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrep-scope-"));
  const output = join(tmpdir(), `${root.split("/").at(-1)}.json`);
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const source =
      "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nspec:\n  ingress:\n    - {}\n";
    writeFileSync(join(root, "policy.yaml"), source);
    writeFileSync(join(root, "book.pdf"), source);
    mkdirSync(join(root, "tools"));
    mkdirSync(join(root, "src/tools"), { recursive: true });
    writeFileSync(join(root, "tools/jshint.js"), source);
    writeFileSync(join(root, "src/tools/jshint.js"), source);
    symlinkSync("policy.yaml", join(root, "link.js"));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=OpenGrep Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: root },
    );
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const env = {
      ...process.env,
      OPENGREP_BINARY: binary,
      SCAN_ROOT: root,
      REPORT_PATH: output,
      SCAN_PROFILE: "config",
      SCAN_MODE: "full",
      SCAN_HEAD: head,
      SCAN_BASE: head,
      TOOLING_SHA: "a".repeat(40),
      GITHUB_REPOSITORY: "beastyrabbit/beasty_printer_hub",
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
    };
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(r.status, 0);
    assert.ok(
      report.findings.some(
        (f) => f.rule === "network-policy-ingress-any" && f.path === "policy.yaml",
      ),
    );
    assert.ok(!report.findings.some((f) => f.path === "book.pdf"));
    assert.ok(!report.findings.some((f) => f.path === "tools/jshint.js"));
    assert.ok(report.findings.some((f) => f.path === "src/tools/jshint.js"));
    assert.equal(report.status, "complete");
    writeFileSync(join(root, "new-policy.yaml"), source);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=OpenGrep Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "new policy",
      ],
      { cwd: root },
    );
    const next = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const pr = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...env, SCAN_HEAD: next, SCAN_BASE: head, SCAN_MODE: "pr" },
    });
    const delta = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(pr.status, 0);
    assert.equal(delta.status, "complete");
    assert.ok(delta.findings.some((f) => f.path === "new-policy.yaml"));
    assert.ok(
      !delta.findings.some((f) => f.path === "policy.yaml" || f.path === "src/tools/jshint.js"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { force: true });
  }
});
