import { appendFileSync, readFileSync, statSync } from "node:fs";
import {
  addedLines,
  findingMarker,
  SHA,
  SUMMARY_MARKER,
  summary,
  trustedPullAuthor,
  validateReport,
} from "./model.ts";

const token = process.env.GH_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
if (!token || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error("Missing reporter identity");
const apiRoot = `https://api.github.com/repos/${repository}`;
interface Pull {
  number: number;
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
    const items = await api<T[]>(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error("Pagination limit reached");
}

async function publish(): Promise<void> {
  const reportPath = process.env.REPORT_PATH ?? "";
  if (statSync(reportPath).size > 32 * 1024 * 1024) throw new Error("Oversized report");
  const file = readFileSync(reportPath);
  const report = validateReport(JSON.parse(file.toString("utf8")));
  if (
    report.repository !== repository ||
    report.runId !== process.env.GITHUB_RUN_ID ||
    report.attempt !== process.env.GITHUB_RUN_ATTEMPT ||
    report.head !== process.env.SCAN_HEAD ||
    report.base !== process.env.SCAN_BASE ||
    report.tooling !== process.env.TOOLING_SHA
  ) {
    throw new Error("Report provenance mismatch");
  }
  const runUrl = `https://github.com/${repository}/actions/runs/${report.runId}`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(report, runUrl));
  const pr = process.env.PR_NUMBER ?? "";
  if (!pr) {
    if (report.status === "incomplete") throw new Error("Incomplete scan");
    return;
  }
  if (!/^\d+$/.test(pr)) throw new Error("Invalid PR number");
  async function current(): Promise<void> {
    const pull = await api<Pull>(`/pulls/${pr}`);
    if (
      pull.state !== "open" ||
      pull.head.sha !== report.head ||
      pull.base.sha !== report.base ||
      pull.head.repo?.full_name !== repository ||
      pull.base.repo.full_name !== repository ||
      !trustedPullAuthor(repository, pull.user.login, pull.author_association)
    )
      throw new Error("PR changed or is not trusted; report withheld");
  }
  await current();
  // GITHUB_TOKEN identifies as the platform's verified github-actions bot, not a human or AI reviewer.
  const botResponse = await fetch("https://api.github.com/users/github-actions%5Bbot%5D", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!botResponse.ok) throw new Error("Cannot resolve bot identity");
  const bot = (await botResponse.json()) as { id: number; login: string; type: string };
  if (bot.login !== "github-actions[bot]" || bot.type !== "Bot" || !Number.isSafeInteger(bot.id)) {
    throw new Error("Invalid bot identity");
  }
  const comments = await all<Comment>(`/issues/${pr}/comments`);
  const own = comments.find((c) => c.user.id === bot.id && c.body.startsWith(SUMMARY_MARKER));
  const body = summary(report, runUrl);
  await current();
  if (own) await api(`/issues/comments/${own.id}`, "PATCH", { body });
  else await api(`/issues/${pr}/comments`, "POST", { body });

  const files = await all<{ filename: string; patch?: string }>(`/pulls/${pr}/files`);
  const locations = new Map(files.map((f) => [f.filename, addedLines(f.patch ?? "")]));
  const reviews = await all<Comment>(`/pulls/${pr}/comments`);
  const existing = new Set(
    reviews.filter((c) => c.user.id === bot.id).map((c) => c.body.split("\n")[0]),
  );
  const inline = report.findings
    .filter((f) => locations.get(f.path)?.has(f.line) && !existing.has(findingMarker(f)))
    .slice(0, 20);
  if (inline.length) {
    await current();
    if (!SHA.test(report.head)) throw new Error("Invalid commit");
    await api(`/pulls/${pr}/reviews`, "POST", {
      commit_id: report.head,
      event: "COMMENT",
      comments: inline.map((f) => ({
        path: f.path,
        line: f.line,
        side: "RIGHT",
        body: `${findingMarker(f)}\nOpenGrep: ${f.rule}\nReview this finding; it is not a confirmed vulnerability.`,
      })),
    });
  }
  await current();
  await api("/check-runs", "POST", {
    name: "OpenGrep / report",
    head_sha: report.head,
    status: "completed",
    conclusion:
      report.status === "incomplete"
        ? "failure"
        : report.status === "not-applicable" || report.findings.length
          ? "neutral"
          : "success",
    details_url: runUrl,
    output: {
      title:
        report.status === "incomplete"
          ? "Analysis incomplete"
          : `${report.findings.length} new findings; reporting only`,
      summary: body,
    },
  });
  if (report.status === "incomplete") process.exitCode = 1;
}

try {
  await publish();
} catch {
  const head = process.env.SCAN_HEAD ?? "";
  if (process.env.PR_NUMBER && SHA.test(head)) {
    await api("/check-runs", "POST", {
      name: "OpenGrep / report",
      head_sha: head,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "OpenGrep report unavailable",
        summary:
          "Analysis or publication failed, or this run is stale. Inspect the workflow run; no clean result was reported.",
      },
    }).catch(() => process.stderr.write("Could not publish the failure check.\n"));
  }
  process.stderr.write("OpenGrep analysis or publication did not complete.\n");
  process.exitCode = 1;
}
