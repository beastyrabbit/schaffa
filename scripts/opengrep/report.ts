import { appendFileSync, readFileSync, statSync } from "node:fs";
import {
  primaryFindings,
  SHA,
  SUMMARY_MARKER,
  summary,
  trustedPullAuthor,
  validateReport,
} from "./model.ts";

const token = process.env.GH_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const head = process.env.SCAN_HEAD ?? "";
const base = process.env.SCAN_BASE ?? "";
const pr = process.env.PR_NUMBER ?? "";
const run = process.env.GITHUB_RUN_ID ?? "";
if (
  !token ||
  !repository ||
  !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
  !SHA.test(head) ||
  !SHA.test(base) ||
  !/^\d+$/.test(run) ||
  (pr && !/^\d+$/.test(pr))
)
  throw new Error("Missing reporter identity");
const apiRoot = `https://api.github.com/repos/${repository}`;
const runUrl = `https://github.com/${repository}/actions/runs/${run}`;
let mayUpdateFailureComment = true;
interface Pull {
  state: string;
  user: { login: string };
  author_association?: string;
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string; repo: { full_name: string } };
}
interface Comment {
  id: number;
  body: string;
  user: { id: number };
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub reporter request failed: ${response.status}`);
  return (await response.json()) as T;
}
async function all<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const items = await api<T[]>(`${path}?per_page=100&page=${page}`);
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error("Pagination limit reached");
}
async function current(): Promise<void> {
  const pull = await api<Pull>(`/pulls/${pr}`);
  if (
    pull.state !== "open" ||
    pull.head.sha !== head ||
    pull.base.sha !== base ||
    pull.head.repo?.full_name !== repository ||
    pull.base.repo.full_name !== repository ||
    !trustedPullAuthor(repository ?? "", pull.user.login, pull.author_association)
  )
    throw new Error("PR changed or is not trusted; report withheld");
}
async function comment(body: string): Promise<void> {
  await current();
  const response = await fetch("https://api.github.com/users/github-actions%5Bbot%5D", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("Cannot resolve bot identity");
  const bot = (await response.json()) as { id: number; login: string; type: string };
  if (bot.login !== "github-actions[bot]" || bot.type !== "Bot" || !Number.isSafeInteger(bot.id))
    throw new Error("Invalid bot identity");
  const comments = await all<Comment>(`/issues/${pr}/comments`);
  const own = comments.find((c) => c.user.id === bot.id && c.body.startsWith(SUMMARY_MARKER));
  await current();
  if (own?.body === body) return;
  if (own) await api(`/issues/comments/${own.id}`, "PATCH", { body });
  else await api(`/issues/${pr}/comments`, "POST", { body });
}
async function check(
  title: string,
  body: string,
  conclusion?: "success" | "neutral" | "failure",
): Promise<void> {
  const id = process.env.CHECK_RUN_ID;
  const checkAttempt = process.env.CHECK_RUN_ATTEMPT || process.env.GITHUB_RUN_ATTEMPT;
  if (!/^\d+$/.test(checkAttempt ?? "")) throw new Error("Invalid check attempt");
  const externalId = `opengrep-${run}-${checkAttempt}`;
  if (id) {
    if (!/^\d+$/.test(id)) throw new Error("Invalid check identity");
    const existing = await api<{ head_sha: string; name: string; external_id: string }>(
      `/check-runs/${id}`,
    );
    if (
      existing.head_sha !== head ||
      existing.name !== "OpenGrep / report" ||
      existing.external_id !== externalId
    )
      throw new Error("Check provenance mismatch");
  }
  const data = {
    name: "OpenGrep / report",
    ...(id ? {} : { head_sha: head }),
    external_id: externalId,
    status: conclusion ? "completed" : "in_progress",
    ...(conclusion ? { conclusion } : {}),
    details_url: runUrl,
    output: { title, summary: body },
  };
  await api(id ? `/check-runs/${id}` : "/check-runs", id ? "PATCH" : "POST", data);
}
function lifecycleBody(state: string): string {
  return `${SUMMARY_MARKER}\n### OpenGrep\n${state}\n\nCommit: ${head.slice(0, 12)}\n[Current workflow run](${runUrl})`;
}

async function publish(): Promise<void> {
  const path = process.env.REPORT_PATH ?? "";
  if (statSync(path).size > 32 * 1024 * 1024) throw new Error("Oversized report");
  mayUpdateFailureComment = false;
  const report = validateReport(JSON.parse(readFileSync(path, "utf8")));
  if (
    report.repository !== repository ||
    report.runId !== run ||
    report.attempt !== process.env.GITHUB_RUN_ATTEMPT ||
    report.head !== head ||
    report.base !== base ||
    report.tooling !== process.env.TOOLING_SHA
  )
    throw new Error("Report provenance mismatch");
  mayUpdateFailureComment = true;
  const body = summary(report, runUrl);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  if (pr) {
    await comment(body);
    await current();
    const count = primaryFindings(report).length;
    await check(
      report.status === "incomplete" ? "Analysis incomplete" : `${count} findings; reporting only`,
      body,
      report.status === "incomplete"
        ? "failure"
        : report.status === "not-applicable" || count
          ? "neutral"
          : "success",
    );
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "published=true\n");
  if (report.status === "incomplete") process.exitCode = 1;
}

try {
  await publish();
} catch {
  if (pr) {
    const body = lifecycleBody(
      "Analysis unavailable or interrupted. No clean result for this commit. Inspect the workflow run.",
    );
    // Only the current trusted PR gets a comment; stale runs cannot overwrite a newer summary.
    if (mayUpdateFailureComment)
      await comment(body).catch(() =>
        process.stderr.write("Could not update the current summary.\n"),
      );
    await check("OpenGrep report unavailable", body, "failure").catch(() =>
      process.stderr.write("Could not publish the failure check.\n"),
    );
  }
  process.stderr.write("OpenGrep analysis or publication did not complete.\n");
  process.exitCode = 1;
}
