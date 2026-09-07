import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

interface TokenOptions {
  token?: string;
  "ignore-token"?: boolean;
}

interface TokenContext {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
}

export function resolveToken(
  options: TokenOptions,
  context: TokenContext = {},
): string | undefined {
  if (options["ignore-token"]) {
    if (options.token !== undefined) {
      throw new Error("--token and --ignore-token cannot be used together.");
    }
    return undefined;
  }
  if (options.token !== undefined) return options.token;
  const environment = context.environment ?? process.env;
  if (environment.SCHAFFA_TOKEN?.trim()) return environment.SCHAFFA_TOKEN.trim();

  const cwd = context.cwd ?? process.cwd();
  const home = context.home ?? os.homedir();
  const configHome = environment.XDG_CONFIG_HOME || path.join(home, ".config");
  const directories = [
    path.join(cwd, ".schaffa"),
    path.join(configHome, "schaffa"),
    path.join(home, ".schaffa"),
  ];
  const candidates = [
    path.join(cwd, ".env.local"),
    path.join(cwd, ".env"),
    ...directories.flatMap((directory) =>
      ["token", "config.json", ".env"].map((name) => path.join(directory, name)),
    ),
  ];
  for (const file of candidates) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Cannot read Schaffa token file: ${file}`);
    }
    let token: unknown;
    if (path.basename(file) === "token") {
      token = content;
    } else if (file.endsWith(".json")) {
      try {
        const config = JSON.parse(content.replace(/^\uFEFF/, ""));
        token = config?.token ?? config?.SCHAFFA_TOKEN;
      } catch {
        throw new Error(`Invalid JSON in Schaffa token file: ${file}`);
      }
    } else {
      token = parseEnv(content).SCHAFFA_TOKEN;
    }
    if (typeof token === "string" && token.trim()) return token.trim();
  }
  return undefined;
}
