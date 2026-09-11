// Trusted scan policy. Repository code cannot add its own exclusions.
import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
export const AUDIT_RULES = new Set(["raptor-bad-words"]);
export const MAX_TARGET_BYTES = 20000000;
export const EXCLUDES = [
  ".git",
  "node_modules",
  ".venv",
  "dist",
  "build",
  "coverage",
  ".github/opengrep/vendor",
  "*.pdf",
  "*.PDF",
];

// Only diagnosed, vendored bundles. Never exclude own source or all *.min.js files.
const VENDOR_EXCLUDES: Record<string, string[]> = {
  "beastyrabbit/beasty_printer_hub": ["tools/jshint.js"],
  "SKYWAY-GmbH/helma": [
    "src/helma/assets/raphael.min.js",
    "docs/evidence/board-09-detailed-flow-r2-2026-08-24/technical/product-surface/assets/raphael.min.js",
    "docs/evidence/board-09-flowchart-r1-2026-08-24/technical/product-surface/assets/raphael.min.js",
  ],
};
export function scanExcludes(): string[] {
  return [...EXCLUDES];
}

export function vendorExcludes(repository: string): string[] {
  return [...(VENDOR_EXCLUDES[repository] ?? [])];
}

// CLI --exclude uses suffix matching even for leading-slash patterns. Split only
// the necessary directories into targets so an own nested lookalike stays scanned.
export function scanTargets(root: string, repository: string): string[] {
  const excluded = vendorExcludes(repository);
  if (!excluded.length) return ["."];
  const targets: string[] = [];
  function visit(relative: string): void {
    if (excluded.includes(relative)) return;
    // Explicit file targets bypass the engine's --exclude filtering.
    if (
      /\.pdf$/i.test(relative) ||
      EXCLUDES.filter((p) => !p.includes("*")).some(
        (p) => relative === p || relative.endsWith(`/${p}`),
      )
    )
      return;
    const absolute = resolve(root, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile() && stat.size > MAX_TARGET_BYTES) return;
    if (
      (relative === "" || excluded.some((p) => p.startsWith(`${relative}/`))) &&
      stat.isDirectory()
    ) {
      for (const name of readdirSync(absolute).sort())
        visit(relative ? `${relative}/${name}` : name);
    } else targets.push(`./${relative}`);
  }
  visit("");
  return targets;
}
