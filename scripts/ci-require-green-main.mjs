import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const WORKFLOW = "verify.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`;
const PER_PAGE = 100;
const MAX_PAGES = 10;
const PENDING = new Set(["requested", "queued", "pending", "waiting", "in_progress"]);

async function main() {
  const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  await requireGreenMainCi({
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    repository: required("GITHUB_REPOSITORY"),
    sha: required("GITHUB_SHA"),
    token: required("GH_TOKEN"),
  });
}

// Waits for the newest main push run of verify.yml on this exact commit and
// requires it to have passed. Anything unexpected fails closed.
export async function requireGreenMainCi({
  apiUrl,
  repository,
  sha,
  token,
  fetch = globalThis.fetch,
  timeoutMs = 10 * 60_000,
  intervalMs = 15_000,
  now = Date.now,
  sleep = delay,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Commit ${sha} is not a full SHA.`);
  const deadline = now() + timeoutMs;
  for (;;) {
    const run = await newestRun({ apiUrl, repository, sha, token, fetch });
    if (run?.status === "completed") {
      if (run.conclusion === "success") {
        log(`${WORKFLOW} passed for ${sha}: ${describe(run)}`);
        return run;
      }
      throw new Error(`${WORKFLOW} concluded ${run.conclusion} for ${sha}: ${describe(run)}`);
    }
    if (run && !PENDING.has(run.status)) {
      throw new Error(`${WORKFLOW} has unexpected status ${run.status}: ${describe(run)}`);
    }
    const state = run ? `${run.status}: ${describe(run)}` : "no run yet";
    if (now() >= deadline) {
      throw new Error(`Timed out waiting for ${WORKFLOW} on ${sha} (${state}).`);
    }
    log(`Waiting for ${WORKFLOW} on ${sha} (${state}).`);
    await sleep(Math.min(intervalMs, deadline - now()));
  }
}

async function newestRun({ apiUrl, repository, sha, token, fetch }) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGES) throw new Error(`GitHub returned more than ${MAX_PAGES} pages of runs.`);
    const url = new URL(`${apiUrl}/repos/${repository}/actions/workflows/${WORKFLOW}/runs`);
    url.search = new URLSearchParams({
      event: "push",
      branch: "main",
      head_sha: sha,
      per_page: String(PER_PAGE),
      page: String(page),
    }).toString();
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${url}.`);
    const body = await response.json();
    if (
      !Array.isArray(body?.workflow_runs) ||
      !Number.isSafeInteger(body.total_count) ||
      body.total_count < 0 ||
      body.workflow_runs.length > PER_PAGE
    ) {
      throw new Error(`GitHub returned an unexpected workflow runs response for ${url}.`);
    }
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < PER_PAGE) break;
  }
  for (const run of runs) {
    if (
      !run ||
      typeof run.path !== "string" ||
      typeof run.event !== "string" ||
      typeof run.head_branch !== "string" ||
      typeof run.head_sha !== "string" ||
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      typeof run.created_at !== "string" ||
      Number.isNaN(Date.parse(run.created_at)) ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1 ||
      typeof run.html_url !== "string" ||
      !URL.canParse(run.html_url) ||
      typeof run.status !== "string" ||
      (run.status === "completed" && typeof run.conclusion !== "string")
    ) {
      throw new Error(`GitHub returned a malformed workflow run: ${JSON.stringify(run?.id)}.`);
    }
  }
  // The query parameters are filters we asked for, not guarantees we rely on.
  const matching = runs.filter(
    (run) =>
      run.path === WORKFLOW_PATH &&
      run.event === "push" &&
      run.head_branch === "main" &&
      run.head_sha === sha,
  );
  // Never filter on success: a newer failing run must win over an older pass.
  return matching.sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
  )[0];
}

function describe(run) {
  return `${run.html_url} (run ${run.id}, attempt ${run.run_attempt})`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
