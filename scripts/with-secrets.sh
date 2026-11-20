#!/usr/bin/env bash
# Runs a command with the secrets of one environment from the local store,
# .secrets/infisical.<env>.env (dev, prod, …).
# Usage: bash scripts/with-secrets.sh <env> <command...>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_SLUG="${1:-dev}"; shift || true
# A plain name only, so the argument can't point outside .secrets/.
if ! [[ "$ENV_SLUG" =~ ^[a-z0-9-]+$ ]]; then
  echo "with-secrets: invalid environment name: $ENV_SLUG" >&2
  exit 1
fi
[ "$#" -gt 0 ] || set -- npm run start

# грейдер не має доступу до сховища: значення вже в оточенні
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.secrets/infisical.$ENV_SLUG.env"
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
