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
command -v docker >/dev/null 2>&1 || {
  echo "Docker is required to run the local virus scanner." >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "Node.js is required for local development." >&2
  exit 1
}

export SCHAFFA_DATA_DIR="${SCHAFFA_DATA_DIR:-./data/local}"
export SCHAFFA_TOKEN_PEPPER="${SCHAFFA_TOKEN_PEPPER:-$(openssl rand -hex 32)}"
export SCHAFFA_BOOTSTRAP_TOKEN="${SCHAFFA_BOOTSTRAP_TOKEN:-sfa_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')}"
export CLAMAV_HOST="${CLAMAV_HOST:-127.0.0.1}"
if [ -z "${CLAMAV_DEV_PORT:-}" ]; then
  CLAMAV_DEV_PORT="$(node -e "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close()})")"
  export CLAMAV_DEV_PORT
fi
export CLAMAV_PORT="${CLAMAV_PORT:-$CLAMAV_DEV_PORT}"

dev_compose() {
  # Compose interpolates every service before selecting clamav. Keep its
  # production-only requirements scoped away from the local application.
  SCHAFFA_IMAGE="${SCHAFFA_IMAGE:-schaffa-local-dev}" \
    SCHAFFA_BASE_URL="${SCHAFFA_BASE_URL:-http://schaffa.localhost:1355}" \
    docker compose -p schaffa-dev "$@"
}

cleanup() {
  dev_compose stop clamav >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

dev_compose up -d clamav
scanner_id="$(dev_compose ps -q clamav)"
attempt=0
while [ "$(docker inspect --format '{{.State.Health.Status}}' "$scanner_id" 2>/dev/null || true)" != "healthy" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 180 ]; then
    echo "ClamAV did not become healthy within three minutes." >&2
    exit 1
  fi
  sleep 1
done

echo "Local Schaffa admin token (valid for this run):"
echo "$SCHAFFA_BOOTSTRAP_TOKEN"
echo
echo "Open the /admin path of the Portless URL printed below and sign in with this token."

portless
