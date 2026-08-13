#!/usr/bin/env bash
set -euo pipefail

image_ref="${1:?Usage: ci-trivy.sh <image-ref>}"
trivy_version="0.73.0"
trivy_archive="trivy_${trivy_version}_Linux-64bit.tar.gz"
trivy_sha256="2edd39da482bb4e9831962487b68f68e3928ec3137794757f54d00383d79547b"
trivy_dir="${RUNNER_TEMP:-/tmp}/trivy-${trivy_version}"
trivy_cache_dir="${RUNNER_TEMP:-/tmp}/trivy-cache-${trivy_version}"

mkdir -p "$trivy_dir"
curl -fsSL \
  "https://github.com/aquasecurity/trivy/releases/download/v${trivy_version}/${trivy_archive}" \
  -o "$trivy_dir/$trivy_archive"
printf '%s  %s\n' "$trivy_sha256" "$trivy_dir/$trivy_archive" | sha256sum -c -
tar -xzf "$trivy_dir/$trivy_archive" -C "$trivy_dir" trivy
scan() {
  "$trivy_dir/trivy" image \
    --exit-code 1 \
    --ignore-unfixed \
    --quiet \
    --scanners vuln \
    --severity HIGH,CRITICAL \
    --skip-version-check \
    --cache-dir "$trivy_cache_dir" \
    "$@" \
    "$image_ref"
}

if ! scan; then
  echo "Default Trivy database mirror failed; retrying once through the GHCR registry." >&2
  rm -rf "$trivy_cache_dir/db"
  scan --db-repository ghcr.io/aquasecurity/trivy-db:2
fi
