#!/usr/bin/env bash
set -euo pipefail

# Compare sets: source maps are uploaded only for the code in the published image.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
for index in 1 2; do
  directory="${!index}"
  grep -rhoE --include='*.js' '^//# debugId=[0-9a-f-]+$' "$directory" | sort -u > "$scratch/$index"
  test -s "$scratch/$index"
done
diff -u "$scratch/1" "$scratch/2"
