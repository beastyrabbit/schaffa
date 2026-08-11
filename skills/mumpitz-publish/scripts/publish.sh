#!/bin/sh
set -eu

if [ "$#" -lt 2 ]; then
  echo "Usage: publish.sh page <html-file> | publish.sh page <slug> <html-file> | publish.sh file <path>" >&2
  exit 2
fi

: "${MUMPITZ_URL:?Set MUMPITZ_URL to the Mumpitz origin}"
: "${MUMPITZ_TOKEN:?Set MUMPITZ_TOKEN to a scoped bearer token}"

case "$1" in
  page)
    if [ "$#" -eq 2 ]; then
      curl --fail-with-body --silent --show-error \
        --request POST \
        --header "Authorization: Bearer ${MUMPITZ_TOKEN}" \
        --form "html=@${2};type=text/html" \
        "${MUMPITZ_URL%/}/api/pages"
    elif [ "$#" -eq 3 ]; then
      curl --fail-with-body --silent --show-error \
        --request PUT \
        --header "Authorization: Bearer ${MUMPITZ_TOKEN}" \
        --form "html=@${3};type=text/html" \
        "${MUMPITZ_URL%/}/api/pages/${2}"
    else
      echo "Usage: publish.sh page <html-file> | publish.sh page <slug> <html-file>" >&2
      exit 2
    fi
    ;;
  file)
    [ "$#" -eq 2 ] || { echo "Usage: publish.sh file <path>" >&2; exit 2; }
    curl --fail-with-body --silent --show-error \
      --request POST \
      --header "Authorization: Bearer ${MUMPITZ_TOKEN}" \
      --form "file=@${2}" \
      "${MUMPITZ_URL%/}/api/files"
    ;;
  *)
    echo "Unknown operation: $1" >&2
    exit 2
    ;;
esac
