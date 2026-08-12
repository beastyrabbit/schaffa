#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { upload } from "./client.js";

const help = `Schaffa is the workhorse that connects an agent's output to the web.

Its name comes from the Swabian word for working and getting things done.

Usage:
  schaffa upload <file> [--token <token>] [--slug <slug>] [--json]

Environment:
  SCHAFFA_TOKEN  Optional for new HTML pages; required for files and updates.
  SCHAFFA_URL    Server origin. Defaults to https://schaffa.dev.

Options:
  --token <token>  Use this bearer token instead of SCHAFFA_TOKEN.
                   Command-line tokens may be stored in shell history.
  --slug <slug>  Update an existing HTML page and create its next version.
  --json         Print the complete JSON response.
  -h, --help     Show this help.
`;

export interface CliOptions {
  filePath: string;
  token?: string;
  baseUrl?: string;
  slug?: string;
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
      token: { type: "string" },
    },
  });

  if (values.help) return { help: true };
  if (positionals[0] !== "upload" || !positionals[1] || positionals.length !== 2) {
    throw new Error(`Invalid command.\n\n${help}`);
  }

  const token = values.token !== undefined ? values.token : environment.SCHAFFA_TOKEN;
  return {
    filePath: positionals[1],
    ...(token !== undefined ? { token } : {}),
    ...(environment.SCHAFFA_URL ? { baseUrl: environment.SCHAFFA_URL } : {}),
    ...(values.slug ? { slug: values.slug } : {}),
    json: values.json || false,
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if ("help" in options) {
    process.stdout.write(help);
    return;
  }
  const { json, ...uploadOptions } = options;
  const result = await upload(uploadOptions);
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.publicUrl}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error.";
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
