import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Exercise the actual checkout-independent workflow fallback, including its GitHub API calls.
const workflow = readFileSync(
  new URL("../.github/workflows/opengrep-shared.yml", import.meta.url),
  "utf8",
);
const script = workflow
  .match(/with: &lifecycle\n\s+script: \|\n([\s\S]*?)\n\n {2}scan:/)[1]
  .split("\n")
  .map((s) => s.slice(12))
  .join("\n");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
async function run(phase, scenario = "current") {
  const writes = [];
  const outputs = {};
  const head = "a".repeat(40),
    base = "b".repeat(40);
  let reads = 0;
  const pull = () => ({
    state: "open",
    user: { login: "beastyrabbit" },
    author_association: "OWNER",
    head: {
      sha: scenario === "stale" || (scenario === "changed" && reads > 1) ? "f".repeat(40) : head,
      repo: { full_name: "beastyrabbit/fixture" },
    },
    base: { sha: base, repo: { full_name: "beastyrabbit/fixture" } },
  });
  const record = (kind) => async (data) => {
    writes.push({ kind, ...data });
    return { data: { id: 123 } };
  };
  const github = {
    rest: {
      pulls: {
        get: async () => {
          reads++;
          return { data: pull() };
        },
      },
      checks: {
        create: record("create-check"),
        update: record("update-check"),
        get: async () => ({
          data: {
            head_sha: head,
            name: "OpenGrep / report",
            external_id: scenario === "wrong-check" ? "other-run" : "opengrep-1-1",
          },
        }),
      },
      users: {
        getByUsername: async () => ({
          data: { id: 42, login: "github-actions[bot]", type: "Bot" },
        }),
      },
      issues: {
        listComments() {},
        updateComment: record("update-comment"),
        createComment: record("create-comment"),
      },
    },
    paginate: async () => [
      { id: 9, user: { id: 99 }, body: "<!-- homelab-opengrep-summary-v1 -->" },
      ...(scenario === "first"
        ? []
        : [{ id: 10, user: { id: 42 }, body: "<!-- homelab-opengrep-summary-v1 --> old success" }]),
    ],
  };
  const context = { repo: { owner: "beastyrabbit", repo: "fixture" }, runId: 1 };
  const process = {
    env: {
      SCAN_HEAD: head,
      SCAN_BASE: base,
      PR_NUMBER: "2",
      REPORT_PHASE: phase,
      CHECK_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: scenario === "rerun" ? "2" : "1",
      CHECK_RUN_ATTEMPT: "1",
    },
  };
  await new AsyncFunction("github", "context", "core", "process", script)(
    github,
    context,
    {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
    },
    process,
  );
  return { writes, outputs };
}

test("start creates the current-head check and updates only the bot summary", async () => {
  const r = await run("start");
  assert.equal(r.outputs["check-id"], 123);
  assert.equal(r.writes[0].head_sha, "a".repeat(40));
  assert.equal(r.writes[0].status, "in_progress");
  assert.equal(r.writes[1].comment_id, 10);
  assert.match(r.writes[1].body, /Analysis in progress/);
});
test("missing artifacts or checkout failures close the original check without a new comment thread", async () => {
  const r = await run("failure");
  assert.equal(r.writes.length, 2);
  assert.equal(r.writes[0].kind, "update-check");
  assert.equal(r.writes[0].check_run_id, 123);
  assert.equal(r.writes[0].conclusion, "failure");
  assert.equal(r.writes[1].comment_id, 10);
  assert.match(r.writes[1].body, /unavailable or interrupted/);
});
test("a new PR gets one comment; stale or changed heads cannot overwrite the summary", async () => {
  assert.equal(
    (await run("start", "first")).writes.filter((w) => w.kind === "create-comment").length,
    1,
  );
  for (const scenario of ["stale", "changed"]) {
    const r = await run("failure", scenario);
    assert.ok(r.writes.every((w) => w.kind === "update-check"));
  }
  await assert.rejects(run("start", "stale"));
  await assert.rejects(run("failure", "wrong-check"));
});

test("failed-job rerun closes the check from the successful original preparation", async () => {
  const r = await run("failure", "rerun");
  assert.equal(r.writes[0].check_run_id, 123);
  assert.equal(r.writes[0].conclusion, "failure");
});
test("cleanup is scheduled even when preparation fails after producing head metadata", () => {
  assert.match(
    workflow,
    /always\(\) && needs\.prepare\.result != 'skipped' && needs\.prepare\.outputs\.head != ''/,
  );
  assert.match(workflow, /check-attempt: \$\{\{ steps\.metadata\.outputs\.attempt \}\}/);
});
