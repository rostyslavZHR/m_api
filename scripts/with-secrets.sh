#!/usr/bin/env bash
# Runs a command with DB credentials from the local secret store.
# Usage: bash scripts/with-secrets.sh <env> <command...>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

# грейдер не має доступу до сховища: значення вже в оточенні
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.secrets/infisical.env"
if [ ! -f "$CREDS" ]; then
  echo "with-secrets: $CREDS not found." >&2
  echo "  Create it (see README), or export the variables and set SKIP_VAULT=1." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$CREDS"
set +a

exec "$@"
