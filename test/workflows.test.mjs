import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-workflows-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("container tags are promoted only after the exact candidate passes its scan", {}, async (t) => {
  const directory = await fixture(t);
  await writeFile(
    path.join(directory, "ci-promote-image.sh"),
    await readFile(new URL("scripts/ci-promote-image.sh", root)),
  );
  await writeFile(
    path.join(directory, "ci-trivy.sh"),
    'printf "scan %s\\n" "$1" >> "$TRACE"\nexit "$SCAN_STATUS"\n',
  );
  await writeFile(
    path.join(directory, "docker"),
    '#!/bin/sh\nprintf "promote %s\\n" "$*" >> "$TRACE"\n',
    { mode: 0o755 },
  );
  const digest = `registry.example/fixture@sha256:${"a".repeat(64)}`;
  const trace = path.join(directory, "trace");
  const env = {
    PATH: `${directory}:${process.env.PATH}`,
    TRACE: trace,
    IMAGE_TAGS: "registry.example/fixture:1\nregistry.example/fixture:latest",
  };
  await assert.rejects(
    exec("bash", [path.join(directory, "ci-promote-image.sh"), digest], {
      env: { ...env, SCAN_STATUS: "1" },
    }),
  );
  assert.equal(await readFile(trace, "utf8"), `scan ${digest}\n`);
  await writeFile(trace, "");
  await exec("bash", [path.join(directory, "ci-promote-image.sh"), digest], {
    env: { ...env, SCAN_STATUS: "0" },
  });
  const lines = (await readFile(trace, "utf8")).trim().split("\n");
  assert.equal(lines[0], `scan ${digest}`);
  assert.ok(lines[1].endsWith(digest));
  assert.match(lines[1], /--tag registry.example\/fixture:latest/);
  for (const workflow of [".github/workflows/publish.yml", ".forgejo/workflows/release.yaml"]) {
    const source = await readFile(new URL(workflow, root), "utf8");
    const publish = source.indexOf("pnpm publish");
    assert.ok(publish > 0);
    assert.ok(source.indexOf("bash scripts/ci-check-cli.sh") < publish);
    assert.ok(source.indexOf("pnpm audit --prod --audit-level high") < publish);
    assert.ok(source.indexOf("bash scripts/ci-gitleaks.sh") < publish);
  }
});

test("development worktrees start and stop separate scanner projects", {}, async (t) => {
  const directory = await fixture(t);
  const trace = path.join(directory, "trace");
  await writeFile(
    path.join(directory, "docker"),
    '#!/bin/sh\nif [ "$1" = inspect ]; then echo healthy; else printf "%s\\n" "$*" >> "$TRACE"; fi\n',
    { mode: 0o755 },
  );
  await writeFile(path.join(directory, "portless"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const script = await readFile(new URL("scripts/dev.sh", root), "utf8");
  for (const name of ["first", "second"]) {
    const worktree = path.join(directory, name);
    await mkdir(worktree);
    await writeFile(path.join(worktree, "dev.sh"), script);
    await exec("sh", ["dev.sh"], {
      cwd: worktree,
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        TRACE: trace,
        SCHAFFA_TOKEN_PEPPER: "fixture-pepper",
        SCHAFFA_BOOTSTRAP_TOKEN: "fixture-token",
        CLAMAV_DEV_PORT: "3310",
      },
    });
  }
  const lines = (await readFile(trace, "utf8")).trim().split("\n");
  const starts = lines.filter((line) => line.includes("up -d"));
  const stops = lines.filter((line) => line.includes("stop clamav"));
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].split(" ")[2], starts[1].split(" ")[2]);
  assert.deepEqual(
    stops.map((line) => line.split(" ")[2]),
    starts.map((line) => line.split(" ")[2]),
  );
});

test("documented maintenance injects secrets each time and stops backup on a failed stop", {}, async (t) => {
  const directory = await fixture(t);
  const docs = await readFile(new URL("docs/self-hosting.md", root), "utf8");
  const wrapper = docs.match(/schaffa_compose\(\) \{[\s\S]*?\n\}/)[0];
  const backup = docs.split("## Backup and restore")[1].match(/```sh\n([\s\S]*?)```/)[1];
  const trace = path.join(directory, "trace");
  await writeFile(
    path.join(directory, "infisical"),
    '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexport SCHAFFA_TOKEN_PEPPER=fixture-injected\nexec "$@"\n',
    { mode: 0o755 },
  );
  await writeFile(
    path.join(directory, "docker"),
    '#!/bin/sh\nif [ "$1" = compose ]; then [ "$SCHAFFA_TOKEN_PEPPER" = fixture-injected ] || exit 91; fi\nprintf "%s\\n" "$*" >> "$TRACE"\ncase "$*" in *"stop schaffa"*) exit "$STOP_STATUS";; esac\n',
    { mode: 0o755 },
  );
  const env = { PATH: `${directory}:${process.env.PATH}`, TRACE: trace };
  await assert.rejects(
    exec("sh", ["-c", `${wrapper}\n${backup}`], { env: { ...env, STOP_STATUS: "1" } }),
  );
  assert.equal((await readFile(trace, "utf8")).trim(), "compose -p schaffa stop schaffa");
  await writeFile(trace, "");
  await exec("sh", ["-c", `${wrapper}\nschaffa_compose ps\n${backup}`], {
    env: { ...env, STOP_STATUS: "0" },
  });
  assert.match(
    await readFile(trace, "utf8"),
    /compose -p schaffa ps[\s\S]*stop schaffa[\s\S]*run --rm[\s\S]*start schaffa/,
  );
  assert.match(docs, /SCHAFFA_URL="\$SCHAFFA_BASE_URL" npx schaffa upload/);
});
