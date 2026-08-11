#!/usr/bin/env bash
set -euo pipefail

gitleaks_version="8.30.1"
gitleaks_archive="gitleaks_${gitleaks_version}_linux_x64.tar.gz"
gitleaks_sha256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
gitleaks_dir="${RUNNER_TEMP:-/tmp}/gitleaks-${gitleaks_version}"

mkdir -p "$gitleaks_dir"
curl -fsSL \
  "https://github.com/gitleaks/gitleaks/releases/download/v${gitleaks_version}/${gitleaks_archive}" \
  -o "$gitleaks_dir/$gitleaks_archive"
printf '%s  %s\n' "$gitleaks_sha256" "$gitleaks_dir/$gitleaks_archive" | sha256sum -c -
tar -xzf "$gitleaks_dir/$gitleaks_archive" -C "$gitleaks_dir" gitleaks
"$gitleaks_dir/gitleaks" git --redact --no-banner
