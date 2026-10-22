import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { requireGreenMainCi } from "../scripts/ci-require-green-main.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
let nextId = 1;

function run(overrides = {}) {
  const id = nextId++;
  return {
    id,
    path: ".github/workflows/verify.yml",
    event: "push",
    head_branch: "main",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    created_at: "2026-10-21T20:00:00Z",
    html_url: `https://github.com/example/repo/actions/runs/${id}`,
    ...overrides,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function page(runs) {
  return json({ total_count: runs.length, workflow_runs: runs });
}

// Replays one queued response per request and drives a fake clock.
function gate(responses, options = {}) {
  const requests = [];
  const logs = [];
  let clock = 0;
  const promise = requireGreenMainCi({
    apiUrl: "https://api.example",
    repository: "example/repo",
    sha,
    token: "fixture-token",
    fetch: async (url, init) => {
      requests.push({ url: new URL(url), init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      return typeof next === "function" ? next() : next;
    },
    timeoutMs: 60_000,
    intervalMs: 15_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: (line) => logs.push(line),
    ...options,
  });
  return { promise, requests, logs };
}

test("a completed successful main push run for the exact commit passes", async () => {
  const success = run({ run_attempt: 2 });
  const { promise, requests, logs } = gate([page([success])]);
  assert.equal((await promise).id, success.id);
  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url.pathname, "/repos/example/repo/actions/workflows/verify.yml/runs");
  assert.equal(url.searchParams.get("event"), "push");
  assert.equal(url.searchParams.get("branch"), "main");
  assert.equal(url.searchParams.get("head_sha"), sha);
  assert.equal(init.headers.Authorization, "Bearer fixture-token");
  assert.match(logs.at(-1), new RegExp(`${success.html_url} \\(run ${success.id}, attempt 2\\)`));
});

test("successful runs for another commit, event, branch, or workflow never satisfy the gate", async () => {
  for (const mismatch of [
    { head_sha: otherSha },
    { event: "pull_request" },
    { head_branch: "feature" },
    { path: ".github/workflows/publish.yml" },
  ]) {
    const responses = Array.from({ length: 5 }, () => page([run(mismatch)]));
    const { promise, requests } = gate(responses);
    await assert.rejects(promise, /Timed out .*no run yet/);
    assert.equal(requests.length, 5);
  }
});

test("queued and in-progress runs are polled until they succeed", async () => {
  const { promise, requests, logs } = gate([
    page([]),
    page([run({ id: 7, status: "queued", conclusion: null })]),
    page([run({ id: 7, status: "in_progress", conclusion: null })]),
    page([run({ id: 7 })]),
  ]);
  assert.equal((await promise).id, 7);
  assert.equal(requests.length, 4);
  assert.match(logs[0], /no run yet/);
  assert.match(logs[1], /queued: .*run 7, attempt 1/);
  assert.match(logs[2], /in_progress/);
});

test("a completed run that did not succeed fails immediately", async () => {
  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
    const { promise, requests } = gate([page([run({ conclusion })])]);
    await assert.rejects(promise, new RegExp(`concluded ${conclusion} .*attempt 1`));
    assert.equal(requests.length, 1);
  }
});

test("a missing run fails after the bounded wait", async () => {
  const responses = Array.from({ length: 10 }, () => page([]));
  const { promise, requests } = gate(responses);
  await assert.rejects(promise, /Timed out waiting for verify\.yml .*no run yet/);
  assert.equal(requests.length, 5);
});

test("API errors and unexpected responses fail closed", async () => {
  const failures = [
    [() => json({ message: "Bad credentials" }, 401), /HTTP 401/],
    [() => json({ message: "boom" }, 500), /HTTP 500/],
    [() => new Response("<html>", { status: 200 }), /JSON/],
    [() => json({ total_count: 1 }), /unexpected workflow runs response/],
    [() => page([null, run()]), /malformed workflow run/],
    [() => page([run({ path: undefined }), run()]), /malformed workflow run/],
    [() => page([run({ created_at: "not a date" })]), /malformed workflow run/],
    [() => page([run({ created_at: null })]), /malformed workflow run/],
    [() => page([run({ id: 0 })]), /malformed workflow run/],
    [() => page([run({ run_attempt: undefined })]), /malformed workflow run/],
    [() => page([run({ html_url: undefined })]), /malformed workflow run/],
    [() => page([run({ conclusion: null })]), /malformed workflow run/],
    [() => json({ total_count: -1, workflow_runs: [] }), /unexpected workflow runs response/],
    [() => page([run({ status: "mystery", conclusion: null })]), /unexpected status mystery/],
    [
      () => {
        throw new TypeError("fetch failed");
      },
      /fetch failed/,
    ],
  ];
  for (const [response, expected] of failures) {
    const { promise, requests } = gate([response]);
    await assert.rejects(promise, expected);
    assert.equal(requests.length, 1);
  }
  await assert.rejects(gate([], { sha: "abc123" }).promise, /not a full SHA/);
});

test("every page is read and the newest matching run decides", async () => {
  const older = Array.from({ length: 100 }, () => run({ created_at: "2026-10-20T00:00:00Z" }));
  const newerFailure = run({ conclusion: "failure", created_at: "2026-10-21T00:00:00Z" });
  const { promise, requests } = gate([page(older), page([newerFailure])]);
  await assert.rejects(promise, new RegExp(`concluded failure .*run ${newerFailure.id}`));
  assert.deepEqual(
    requests.map(({ url }) => url.searchParams.get("page")),
    ["1", "2"],
  );
});

test("a newer failure hides an older success, and a newer success replaces an older failure", async () => {
  const oldSuccess = run({ created_at: "2026-10-20T00:00:00Z" });
  const newFailure = run({ conclusion: "failure", created_at: "2026-10-21T00:00:00Z" });
  await assert.rejects(gate([page([oldSuccess, newFailure])]).promise, /concluded failure/);
  await assert.rejects(gate([page([newFailure, oldSuccess])]).promise, /concluded failure/);
  const oldFailure = run({ conclusion: "failure", created_at: "2026-10-20T00:00:00Z" });
  const newSuccess = run({ created_at: "2026-10-21T00:00:00Z" });
  assert.equal((await gate([page([newSuccess, oldFailure])]).promise).id, newSuccess.id);
});

test("run IDs break creation-time ties and pagination fails closed after ten pages", async () => {
  const success = run();
  const failure = run({ conclusion: "failure" });
  await assert.rejects(gate([page([success, failure])]).promise, /concluded failure/);
  const responses = Array.from({ length: 10 }, () =>
    page(Array.from({ length: 100 }, () => run())),
  );
  const { promise, requests } = gate(responses);
  await assert.rejects(promise, /more than 10 pages/);
  assert.equal(requests.length, 10);
});

test("the command fails closed without its required environment", async () => {
  const script = fileURLToPath(new URL("../scripts/ci-require-green-main.mjs", import.meta.url));
  await assert.rejects(
    promisify(execFile)(process.execPath, [script], {
      env: { PATH: process.env.PATH, GITHUB_REPOSITORY: "example/repo", GITHUB_SHA: sha },
    }),
    /GH_TOKEN is required/,
  );
});
