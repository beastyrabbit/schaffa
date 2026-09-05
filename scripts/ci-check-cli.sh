#!/usr/bin/env bash
set -euo pipefail
package_file="$(realpath "${1:?CLI tarball path is required}")"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
cd "$test_dir"
npm install --engine-strict "$package_file"
npm audit --omit=dev --audit-level=moderate
./node_modules/.bin/schaffa --help
node --input-type=module -e '
  import { createRequire } from "node:module";
  const require = createRequire(new URL("./node_modules/schaffa/package.json", import.meta.url));
  await import(require.resolve("puppeteer-core"));
  await import(require.resolve("@marp-team/marp-cli"));
'
