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
command -v node >/dev/null 2>&1 || {
  echo "Node.js is required for local development." >&2
  exit 1
}

export SCHAFFA_DATA_DIR="${SCHAFFA_DATA_DIR:-./data/local}"
export SCHAFFA_TOKEN_PEPPER="${SCHAFFA_TOKEN_PEPPER:-$(openssl rand -hex 32)}"
export SCHAFFA_BOOTSTRAP_TOKEN="${SCHAFFA_BOOTSTRAP_TOKEN:-sfa_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')}"
export CLAMGATE_BASE_URL="${CLAMGATE_BASE_URL:-https://virus.heerlab.com}"
: "${CLAMGATE_PUBLIC_KEY_FILE:?set the trusted ClamGate public key file}"
: "${CLAMGATE_PUBLIC_KEY_ID:?set the trusted ClamGate public key ID}"
[ -r "$CLAMGATE_PUBLIC_KEY_FILE" ] || {
  echo "ClamGate public key file is not readable." >&2
  exit 1
}

echo "Local Schaffa admin token (valid for this run):"
echo "$SCHAFFA_BOOTSTRAP_TOKEN"
echo
echo "Open the /admin path of the Portless URL printed below and sign in with this token."

portless
