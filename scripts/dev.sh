#!/bin/sh
set -eu

command -v openssl >/dev/null 2>&1 || {
  echo "openssl is required for local development credentials." >&2
  exit 1
}
command -v portless >/dev/null 2>&1 || {
  echo "portless must be installed globally." >&2
  exit 1
}

export MUMPITZ_DATA_DIR="${MUMPITZ_DATA_DIR:-./data/local}"
export MUMPITZ_TOKEN_PEPPER="${MUMPITZ_TOKEN_PEPPER:-$(openssl rand -hex 32)}"
export MUMPITZ_BOOTSTRAP_TOKEN="${MUMPITZ_BOOTSTRAP_TOKEN:-mpt_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')}"

echo "Local Mumpitz admin token (valid for this run):"
echo "$MUMPITZ_BOOTSTRAP_TOKEN"
echo
echo "Open the /admin path at the Portless URL printed below."

exec portless
