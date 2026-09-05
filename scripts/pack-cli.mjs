import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.resolve(process.argv[2] || "artifacts");
const temporary = mkdtempSync(path.join(os.tmpdir(), "schaffa-package-"));
const stage = path.join(temporary, "cli");
const workspace = path.join(temporary, "workspace");
function pnpm(args, cwd = root) {
  execFileSync("pnpm", args, { cwd, stdio: "inherit" });
}
try {
  mkdirSync(destination, { recursive: true });
  pnpm(["--filter", "schaffa", "build"]);
  mkdirSync(path.join(workspace, "packages/cli"), { recursive: true });
  for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"])
    cpSync(path.join(root, file), path.join(workspace, file));
  for (const file of ["package.json", "dist", "assets", "README.md", "LICENSE"])
    cpSync(path.join(root, "packages/cli", file), path.join(workspace, "packages/cli", file), {
      recursive: true,
    });
  // A hoisted deployment bundles the runtime tree from the workspace lockfile,
  // including security overrides that consumer npm installs otherwise ignore.
  // Stage the workspace too: pnpm deploy updates its workspace-state metadata.
  pnpm(
    [
      "--filter",
      "schaffa",
      "deploy",
      "--prod",
      "--config.inject-workspace-packages=true",
      "--config.node-linker=hoisted",
      stage,
    ],
    workspace,
  );
  pnpm(
    [
      "--config.node-linker=hoisted",
      "--config.ignore-scripts=true",
      "pack",
      "--pack-destination",
      destination,
    ],
    stage,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
