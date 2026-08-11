#!/bin/sh
set -eu

if [ "$#" -lt 2 ]; then
  echo "Usage: publish.sh page <html-file> | publish.sh page <slug> <html-file> | publish.sh file <path>" >&2
  exit 2
fi

: "${SCHAFFA_URL:?Set SCHAFFA_URL to the Schaffa origin}"

case "$1" in
  page)
    if [ "$#" -eq 2 ]; then
      if [ -n "${SCHAFFA_TOKEN:-}" ]; then
        curl --fail-with-body --silent --show-error \
          --request POST \
          --header "Authorization: Bearer ${SCHAFFA_TOKEN}" \
          --form "html=@${2};type=text/html" \
          "${SCHAFFA_URL%/}/api/pages"
      else
        curl --fail-with-body --silent --show-error \
          --request POST \
          --form "html=@${2};type=text/html" \
          "${SCHAFFA_URL%/}/api/pages"
      fi
    elif [ "$#" -eq 3 ]; then
      : "${SCHAFFA_TOKEN:?Set SCHAFFA_TOKEN to update a page}"
      curl --fail-with-body --silent --show-error \
        --request PUT \
        --header "Authorization: Bearer ${SCHAFFA_TOKEN}" \
        --form "html=@${3};type=text/html" \
        "${SCHAFFA_URL%/}/api/pages/${2}"
    else
      echo "Usage: publish.sh page <html-file> | publish.sh page <slug> <html-file>" >&2
      exit 2
    fi
    ;;
  file)
    [ "$#" -eq 2 ] || { echo "Usage: publish.sh file <path>" >&2; exit 2; }
    : "${SCHAFFA_TOKEN:?Set SCHAFFA_TOKEN to upload a file}"
    curl --fail-with-body --silent --show-error \
      --request POST \
      --header "Authorization: Bearer ${SCHAFFA_TOKEN}" \
      --form "file=@${2}" \
      "${SCHAFFA_URL%/}/api/files"
    ;;
  *)
    echo "Unknown operation: $1" >&2
    exit 2
    ;;
esac
