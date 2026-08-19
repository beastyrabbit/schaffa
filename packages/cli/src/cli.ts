#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
  addGuideStep,
  deleteGuideStep,
  finishGuide,
  type GuideResult,
  getGuide,
  publishGuide,
  replaceGuideScreenshot,
  startGuide,
  updateGuideStep,
  upload,
} from "./client.js";
import { prepareDesktopRecorder, recordDesktopGuide } from "./desktop-recorder.js";
import {
  findBrowserExecutable,
  readRecordingSlug,
  recordBrowserGuide,
  syncRecording,
} from "./recorder.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const help = `Schaffa publishes pages, presentations, files, and incrementally recorded guides.

Usage:
  schaffa upload <file> [--token <token>] [--interactive] [--json]
  schaffa publish <deck.md> --kind presentation [--export pdf] [--export pptx] [--json]
  schaffa record --title <title> --browser <url> [--browser-executable <path>] [--json]
  schaffa record --title <title> --desktop --app <bundle-id> [--json]
  schaffa guide start --title <title> [--description <text>] [--url <url>] [--language <tag>] [--json]
  schaffa guide record --title <title> --url <url> [--browser <path>] [--json]
  schaffa guide step --title <title> --text <text> [--screenshot <path>] [--action <type>] [--target <text>] [--verification <text>] [--json]
  schaffa guide status [--json]
  schaffa guide edit-step --step <number|id> [--title <title>] [--text <text>] [--verification <text>] [--json]
  schaffa guide delete-step --step <number|id> [--json]
  schaffa guide replace-screenshot --step <number|id> --screenshot <path> [--json]
  schaffa guide sync [--manifest <path>] [--json]
  schaffa guide finish [--json]
  schaffa guide publish [--json]

Environment:
  SCHAFFA_TOKEN  Required for permanent publishing, files, presentations, and guides.
  SCHAFFA_URL    Server origin. Defaults to https://schaffa.dev.

The guide commands persist the active random slug and edit revision in
.schaffa/guide-session.json so an interrupted recording can be resumed.
Automatic recordings also keep every original screenshot and a manifest under
.schaffa/recordings/<slug>/ before uploading each captured click immediately.

Options:
  --token <token>  Use this bearer token instead of SCHAFFA_TOKEN.
                   Command-line tokens may be stored in shell history.
  --interactive    Run inline JavaScript in Schaffa's restricted sandbox.
  --json           Print the complete JSON response.
  -h, --help       Show this help.
`;

export interface CliOptions {
  command: "upload";
  filePath: string;
  token?: string;
  baseUrl?: string;
  interactive: boolean;
  json: boolean;
}

export function parseCliArgs(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): CliOptions | { help: true } {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      interactive: { type: "boolean" },
      token: { type: "string" },
    },
  });
  if (values.help) return { help: true };
  if (positionals[0] !== "upload" || !positionals[1] || positionals.length !== 2) {
    throw new Error(`Invalid command.\n\n${help}`);
  }
  const token = values.token !== undefined ? values.token : environment.SCHAFFA_TOKEN;
  return {
    command: "upload",
    filePath: positionals[1],
    ...(token !== undefined ? { token } : {}),
    ...(environment.SCHAFFA_URL ? { baseUrl: environment.SCHAFFA_URL } : {}),
    interactive: values.interactive || false,
    json: values.json || false,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "record") return runAutomaticRecorder(args.slice(1), false);
  if (args[0] === "guide") {
    if (args[1] === "record") return runAutomaticRecorder(args.slice(2), true);
    return runGuide(args.slice(1));
  }
  if (args[0] === "publish") return runPresentation(args.slice(1));
  const options = parseCliArgs(args);
  if ("help" in options) return void process.stdout.write(help);
  const { json, command: _command, ...uploadOptions } = options;
  const result = await upload(uploadOptions);
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.publicUrl}\n`);
}

async function runAutomaticRecorder(args: string[], legacy: boolean): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      title: { type: "string" },
      description: { type: "string" },
      url: { type: "string" },
      language: { type: "string" },
      desktop: { type: "boolean" },
      app: { type: "string" },
      browser: { type: "string" },
      "browser-executable": { type: "string" },
      token: { type: "string" },
    },
  });
  if (values.help) return void process.stdout.write(help);
  if (!values.title) throw new Error("record requires --title.");
  const selectedToken = values.token || process.env.SCHAFFA_TOKEN;
  if (!selectedToken) throw new Error("SCHAFFA_TOKEN is required for guide operations.");
  const browserUrl = legacy ? values.url : values.browser || values.url;
  if (values.desktop && browserUrl) {
    throw new Error("Choose either --desktop or --browser <url>, not both.");
  }
  if (values.desktop && !values.app) {
    throw new Error("Desktop recording requires --app <bundle-id>.");
  }
  if (!values.desktop && values.app) {
    throw new Error("--app can only be used together with --desktop.");
  }
  if (!values.desktop && !browserUrl) {
    throw new Error(
      legacy
        ? "guide record requires --url (or use --desktop)."
        : "record requires --desktop or --browser <url>.",
    );
  }
  const common = {
    token: selectedToken,
    ...(process.env.SCHAFFA_URL ? { baseUrl: process.env.SCHAFFA_URL } : {}),
  };
  const helper = values.desktop
    ? await prepareDesktopRecorder({ promptForPermissions: true })
    : undefined;
  const browserExecutable = !values.desktop
    ? findBrowserExecutable(legacy ? values.browser : values["browser-executable"])
    : undefined;
  let result = await startGuide({
    ...common,
    title: values.title,
    ...(values.description ? { description: values.description } : {}),
    ...(browserUrl ? { targetUrl: browserUrl } : {}),
    ...(values.language ? { language: values.language } : {}),
  });
  await writeSession(result);
  const recording = values.desktop
    ? await recordDesktopGuide({
        guide: result,
        appBundleId: values.app as string,
        token: selectedToken,
        ...(common.baseUrl ? { baseUrl: common.baseUrl } : {}),
        ...(values.language ? { language: values.language } : {}),
        ...(helper ? { helperExecutable: helper } : {}),
        onMessage: (message) => process.stderr.write(`${message}\n`),
      })
    : await recordBrowserGuide({
        guide: result,
        url: browserUrl as string,
        token: selectedToken,
        ...(common.baseUrl ? { baseUrl: common.baseUrl } : {}),
        ...(values.language ? { language: values.language } : {}),
        ...(browserExecutable ? { browserExecutable } : {}),
        onMessage: (message) => process.stderr.write(`${message}\n`),
      });
  result = recording.guide;
  let output: unknown = {
    guide: result,
    manifestPath: recording.manifestPath,
    failedUploads: recording.failedUploads,
  };
  if (recording.failedUploads === 0) {
    const finished = await finishGuide({ ...common, ...result });
    result = finished.guide;
    output = { ...finished, manifestPath: recording.manifestPath };
  } else {
    process.exitCode = 1;
  }
  await writeSession(result);
  process.stdout.write(values.json ? `${JSON.stringify(output)}\n` : `${result.publicUrl}\n`);
}

async function runGuide(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      title: { type: "string" },
      description: { type: "string" },
      url: { type: "string" },
      language: { type: "string" },
      text: { type: "string" },
      screenshot: { type: "string" },
      action: { type: "string" },
      target: { type: "string" },
      verification: { type: "string" },
      step: { type: "string" },
      browser: { type: "string" },
      manifest: { type: "string" },
      token: { type: "string" },
    },
  });
  if (values.help) return void process.stdout.write(help);
  const command = positionals[0];
  const selectedToken = values.token || process.env.SCHAFFA_TOKEN;
  const common = {
    ...(selectedToken ? { token: selectedToken } : {}),
    ...(process.env.SCHAFFA_URL ? { baseUrl: process.env.SCHAFFA_URL } : {}),
  };
  let result: GuideResult;
  let output: unknown;
  if (command === "start") {
    if (!values.title) throw new Error("guide start requires --title.");
    result = await startGuide({
      ...common,
      title: values.title,
      ...(values.description ? { description: values.description } : {}),
      ...(values.url ? { targetUrl: values.url } : {}),
      ...(values.language ? { language: values.language } : {}),
    });
    output = result;
  } else {
    const session = await readSession();
    if (command === "step") {
      if (!values.title || !values.text) throw new Error("guide step requires --title and --text.");
      const idempotencyKey =
        session.idempotencyKey || `cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await writeSession({ ...session, idempotencyKey });
      result = await addGuideStep({
        ...common,
        ...session,
        title: values.title,
        description: values.text,
        ...(values.action ? { actionType: values.action } : {}),
        ...(values.target ? { actionTarget: values.target } : {}),
        ...(values.verification ? { verification: values.verification } : {}),
        ...(values.screenshot ? { screenshot: values.screenshot } : {}),
        idempotencyKey,
      });
      output = result;
    } else if (command === "status") {
      result = await getGuide({ ...common, slug: session.slug });
      output = result;
    } else if (command === "edit-step") {
      if (!values.step) throw new Error("guide edit-step requires --step.");
      if (!values.title && !values.text && !values.verification) {
        throw new Error("guide edit-step requires --title, --text, or --verification.");
      }
      const current = await getGuide({ ...common, slug: session.slug });
      const stepId = resolveStepId(current, values.step);
      result = await updateGuideStep({
        ...common,
        slug: current.slug,
        editRevision: current.editRevision,
        stepId,
        ...(values.title ? { title: values.title } : {}),
        ...(values.text ? { description: values.text } : {}),
        ...(values.verification ? { verification: values.verification } : {}),
      });
      output = result;
    } else if (command === "delete-step") {
      if (!values.step) throw new Error("guide delete-step requires --step.");
      const current = await getGuide({ ...common, slug: session.slug });
      result = await deleteGuideStep({
        ...common,
        slug: current.slug,
        editRevision: current.editRevision,
        stepId: resolveStepId(current, values.step),
      });
      output = result;
    } else if (command === "replace-screenshot") {
      if (!values.step || !values.screenshot) {
        throw new Error("guide replace-screenshot requires --step and --screenshot.");
      }
      const current = await getGuide({ ...common, slug: session.slug });
      result = await replaceGuideScreenshot({
        ...common,
        slug: current.slug,
        editRevision: current.editRevision,
        stepId: resolveStepId(current, values.step),
        screenshot: values.screenshot,
      });
      output = result;
    } else if (command === "sync") {
      if (!selectedToken) throw new Error("SCHAFFA_TOKEN is required for guide operations.");
      const slug = values.manifest ? await readRecordingSlug(values.manifest) : session.slug;
      const current = await getGuide({ ...common, slug });
      const synced = await syncRecording({
        guide: current,
        token: selectedToken,
        ...(common.baseUrl ? { baseUrl: common.baseUrl } : {}),
        ...(values.manifest ? { manifestPath: values.manifest } : {}),
        onMessage: (message) => process.stderr.write(`${message}\n`),
      });
      result = synced.guide;
      output = synced;
      if (synced.failedUploads > 0) process.exitCode = 1;
    } else if (command === "finish") {
      const operation = await finishGuide({ ...common, ...session });
      result = operation.guide;
      output = operation;
    } else if (command === "publish") {
      const operation = await publishGuide({ ...common, ...session });
      result = operation.guide;
      output = operation;
    } else throw new Error(`Unknown guide command.\n\n${help}`);
  }
  await writeSession(result);
  process.stdout.write(values.json ? `${JSON.stringify(output)}\n` : `${result.publicUrl}\n`);
}

async function runPresentation(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      kind: { type: "string" },
      export: { type: "string", multiple: true },
      token: { type: "string" },
    },
  });
  if (values.help) return void process.stdout.write(help);
  const source = positionals[0];
  if (!source || positionals.length !== 1 || values.kind !== "presentation") {
    throw new Error("publish requires one Markdown file and --kind presentation.");
  }
  const token = values.token || process.env.SCHAFFA_TOKEN;
  if (!token) throw new Error("SCHAFFA_TOKEN is required for presentation publishing.");
  const exportKinds = [...new Set(values.export || [])];
  for (const kind of exportKinds) {
    if (!new Set(["pdf", "pptx"]).has(kind)) {
      throw new Error(`Unsupported presentation export: ${kind}.`);
    }
  }
  const output = await mkdtemp(path.join(os.tmpdir(), "schaffa-presentation-"));
  try {
    const html = path.join(output, "presentation.html");
    const marp = require.resolve("@marp-team/marp-cli/marp-cli.js");
    await execFileAsync(process.execPath, [
      marp,
      source,
      "--no-stdin",
      "--template",
      "bare",
      "--output",
      html,
    ]);
    const rendered = await readFile(html, "utf8");
    const staticHtml = rendered.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    if (/<script\b|<form\b|\son[a-z]+\s*=|(?:src|href)\s*=\s*["']https?:\/\//i.test(staticHtml)) {
      throw new Error("Rendered presentation contains active or external content.");
    }
    const baseUrl = process.env.SCHAFFA_URL || "https://schaffa.dev";
    const uploadCommon = {
      token,
      ...(process.env.SCHAFFA_URL ? { baseUrl: process.env.SCHAFFA_URL } : {}),
    };
    const exports: Record<string, string> = {};
    for (const kind of exportKinds) {
      const artifact = path.join(output, `presentation.${kind}`);
      await execFileAsync(process.execPath, [
        marp,
        source,
        "--no-stdin",
        `--${kind}`,
        "--allow-local-files",
        "--output",
        artifact,
      ]);
      exports[kind] = (await upload({ filePath: artifact, ...uploadCommon })).publicUrl;
    }
    exports.source = (await upload({ filePath: source, ...uploadCommon })).publicUrl;
    const publishedHtml = addPresentationDownloads(staticHtml, exports, baseUrl);
    if (
      /<script\b|<form\b|\son[a-z]+\s*=|(?:src|href)\s*=\s*["']https?:\/\//i.test(publishedHtml)
    ) {
      throw new Error("Rendered presentation contains active or external content.");
    }
    await writeFile(html, publishedHtml);
    const page = await upload({ filePath: html, ...uploadCommon });
    const result = { ...page, kind: "presentation", exports };
    process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : `${result.publicUrl}\n`);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

export function addPresentationDownloads(
  html: string,
  exports: Record<string, string>,
  baseUrl = "https://schaffa.dev",
): string {
  const formats = [
    { key: "pdf", label: "PDF" },
    { key: "pptx", label: "PowerPoint" },
  ].filter(({ key }) => typeof exports[key] === "string");
  if (formats.length === 0) return html;

  const origin = presentationOrigin(baseUrl);
  const links = formats
    .map(({ key, label }) => {
      const href = presentationExportPath(exports[key] as string, origin);
      return `<a href="${escapeHtmlAttribute(href)}" download aria-label="Download ${label}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1v9m0 0 3-3m-3 3L5 7M3 13h10"/></svg><span>${label}</span></a>`;
    })
    .join("");
  const style = `<style id="schaffa-presentation-download-styles">
.schaffa-presentation-downloads{position:fixed;z-index:2147483647;top:max(12px,env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right));display:flex;gap:2px;padding:4px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:#24231f;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.24);font:600 12px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:.82;transition:opacity 120ms ease}
.schaffa-presentation-downloads:hover,.schaffa-presentation-downloads:focus-within{opacity:1}
.schaffa-presentation-downloads a{display:flex;min-height:30px;align-items:center;gap:6px;padding:0 9px;border-radius:6px;color:inherit;text-decoration:none;white-space:nowrap}
.schaffa-presentation-downloads a:hover{background:rgba(255,255,255,.12)}
.schaffa-presentation-downloads a:focus-visible{outline:2px solid #fff;outline-offset:1px}
.schaffa-presentation-downloads svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.6}
@media(max-width:480px){.schaffa-presentation-downloads{top:max(8px,env(safe-area-inset-top));right:max(8px,env(safe-area-inset-right))}.schaffa-presentation-downloads a{padding:0 7px}}
@media print{.schaffa-presentation-downloads{display:none}}
</style>`;
  const navigation = `<nav class="schaffa-presentation-downloads" aria-label="Download presentation">${links}</nav>`;
  if (!/<\/head>/i.test(html) || !/<\/body>/i.test(html)) {
    throw new Error("Rendered presentation is missing a complete HTML document.");
  }
  return html.replace(/<\/head>/i, `${style}</head>`).replace(/<\/body>/i, `${navigation}</body>`);
}

function presentationOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SCHAFFA_URL must be a valid HTTP or HTTPS origin.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("SCHAFFA_URL must be an HTTP or HTTPS origin without a path or credentials.");
  }
  return parsed.origin;
}

function presentationExportPath(value: string, origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Schaffa returned an invalid presentation export URL.");
  }
  if (parsed.origin !== origin) {
    throw new Error("Schaffa returned a presentation export URL from another origin.");
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] as string;
  });
}

const sessionPath = () => path.resolve(".schaffa/guide-session.json");

interface GuideSession {
  slug: string;
  editRevision: number;
  idempotencyKey?: string;
}

async function readSession(): Promise<GuideSession> {
  try {
    const parsed = JSON.parse(await readFile(sessionPath(), "utf8")) as {
      slug?: unknown;
      editRevision?: unknown;
    };
    if (typeof parsed.slug === "string" && Number.isSafeInteger(parsed.editRevision))
      return parsed as GuideSession;
  } catch {}
  throw new Error("No active guide session. Run schaffa guide start first.");
}

async function writeSession(guide: GuideResult | GuideSession): Promise<void> {
  await mkdir(path.dirname(sessionPath()), { recursive: true });
  await writeFile(
    sessionPath(),
    `${JSON.stringify({ slug: guide.slug, editRevision: guide.editRevision, ...("idempotencyKey" in guide && guide.idempotencyKey ? { idempotencyKey: guide.idempotencyKey } : {}) })}\n`,
    { mode: 0o600 },
  );
}

function resolveStepId(guide: GuideResult, value: string): string {
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric >= 1) {
    const step = guide.steps[numeric - 1];
    if (!step) throw new Error(`Guide step ${numeric} does not exist.`);
    return step.id;
  }
  const step = guide.steps.find((candidate) => candidate.id === value);
  if (!step) throw new Error(`Guide step ${value} does not exist.`);
  return step.id;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : "Unknown error."}\n`);
    process.exitCode = 1;
  });
}
