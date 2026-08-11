#!/usr/bin/env node

import { parseArgs } from "node:util";
import { upload } from "./client.js";

const help = `Schaffa is the workhorse that connects an agent's output to the web.

Its name comes from the Swabian word for working and getting things done.

Usage:
  schaffa upload <file> [--slug <slug>] [--json]

Environment:
  SCHAFFA_TOKEN  Optional for new HTML pages; required for files and updates.
                 Never pass it on the command line.
  SCHAFFA_URL    Server origin. Defaults to https://schaffa.dev.

Options:
  --slug <slug>  Update an existing HTML page and create its next version.
  --json         Print the complete JSON response.
  -h, --help     Show this help.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      slug: { type: "string" },
    },
  });

  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (positionals[0] !== "upload" || !positionals[1] || positionals.length !== 2) {
    throw new Error(`Invalid command.\n\n${help}`);
  }

  const token = process.env.SCHAFFA_TOKEN;
  const result = await upload({
    filePath: positionals[1],
    ...(token ? { token } : {}),
    ...(process.env.SCHAFFA_URL ? { baseUrl: process.env.SCHAFFA_URL } : {}),
    ...(values.slug ? { slug: values.slug } : {}),
  });
  process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : `${result.publicUrl}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error.";
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
