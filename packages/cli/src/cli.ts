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
  finishGuide,
  type GuideResult,
  publishGuide,
  startGuide,
  upload,
} from "./client.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const help = `Schaffa publishes pages, presentations, files, and incrementally recorded guides.

Usage:
  schaffa upload <file> [--token <token>] [--slug <slug>] [--interactive] [--json]
  schaffa publish <deck.md> --kind presentation [--export pdf] [--export pptx] [--json]
  schaffa guide start --title <title> [--description <text>] [--language <tag>] [--json]
  schaffa guide step --title <title> --text <text> [--screenshot <path>] [--action <type>] [--target <text>] [--verification <text>] [--json]
  schaffa guide finish [--json]
  schaffa guide publish [--json]

Environment:
  SCHAFFA_TOKEN  Required for permanent publishing, files, presentations, and guides.
  SCHAFFA_URL    Server origin. Defaults to https://schaffa.dev.

The guide commands persist the active random slug and edit revision in
.schaffa/guide-session.json so an interrupted recording can be resumed.

Options:
  --token <token>  Use this bearer token instead of SCHAFFA_TOKEN.
                   Command-line tokens may be stored in shell history.
  --slug <slug>    Publish at a chosen slug; reuse it to create the next version.
  --interactive    Run inline JavaScript in Schaffa's restricted sandbox.
  --json           Print the complete JSON response.
  -h, --help       Show this help.
`;

export interface CliOptions {
  command: "upload";
  filePath: string;
  token?: string;
  baseUrl?: string;
  slug?: string;
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
      slug: { type: "string" },
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
    ...(values.slug ? { slug: values.slug } : {}),
    interactive: values.interactive || false,
    json: values.json || false,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "guide") return runGuide(args.slice(1));
  if (args[0] === "publish") return runPresentation(args.slice(1));
  const options = parseCliArgs(args);
  if ("help" in options) return void process.stdout.write(help);
  const { json, command: _command, ...uploadOptions } = options;
  const result = await upload(uploadOptions);
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.publicUrl}\n`);
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
      language: { type: "string" },
      text: { type: "string" },
      screenshot: { type: "string" },
      action: { type: "string" },
      target: { type: "string" },
      verification: { type: "string" },
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
    await writeFile(html, staticHtml);
    const uploadCommon = {
      token,
      ...(process.env.SCHAFFA_URL ? { baseUrl: process.env.SCHAFFA_URL } : {}),
    };
    const page = await upload({ filePath: html, ...uploadCommon });
    const exports: Record<string, string> = {};
    for (const kind of values.export || []) {
      if (!new Set(["pdf", "pptx"]).has(kind))
        throw new Error(`Unsupported presentation export: ${kind}.`);
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
    const result = { ...page, kind: "presentation", exports };
    process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : `${result.publicUrl}\n`);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : "Unknown error."}\n`);
    process.exitCode = 1;
  });
}
