#!/usr/bin/env bash
set -euo pipefail
candidate="${1:?Candidate digest is required}"
[[ "$candidate" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "Expected an immutable image digest." >&2; exit 1; }
: "${IMAGE_TAGS:?Final tags are required}"
bash "$(dirname "$0")/ci-trivy.sh" "$candidate"
tags=()
while IFS= read -r tag; do
  [[ -z "$tag" ]] || tags+=(--tag "$tag")
done <<< "$IMAGE_TAGS"
[[ ${#tags[@]} -gt 0 ]]
docker buildx imagetools create --prefer-index=false "${tags[@]}" "$candidate"
