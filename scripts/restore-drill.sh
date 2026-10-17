#!/usr/bin/env bash
# Restores the newest backups/shop_*.dump into a brand-new Postgres container,
# compares every table's row count (and orders' total) with the dump's .check, then prints MATCH
# (exit 0) or MISMATCH (exit 1). The container and its volume are removed on
# every exit, so the next run starts from nothing again.
# Usage: bash scripts/restore-drill.sh   (reads files only, no env vars needed)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LABEL=m_api.drill=1
READY_TIMEOUT_S=30

fail() {
  echo "restore-drill: $*" >&2
  exit 1
}

# macOS date has no milliseconds; node is already a dependency of the repo.
now_ms() { node -e 'console.log(Date.now())'; }

started_ms="$(now_ms)"

# The UTC timestamps in the names make alphabetical order time order. Hidden
# temporary files from failed backups (.shop_…) don't match the glob.
shopt -s nullglob
dumps=(backups/shop_*.dump)
shopt -u nullglob
[ "${#dumps[@]}" -gt 0 ] || fail "no dumps in backups/: run backup.sh first"
dump="${dumps[${#dumps[@]}-1]}"
[ -f "$dump.check" ] || fail "no control values for this dump ($dump.check is missing)"
expected="$(cat "$dump.check")"

# One "table rows" line per table, plus public.orders.total_cents (backup.sh).
# An older .check (a single count|sum line) can't be compared table by table.
grep -qvE '^[a-z_.]+ [0-9]+$' "$dump.check" && fail "$dump.check is in an old format: rerun backup.sh"

# The Postgres major version the dump came from, read from its header (plain
# text near the start: the database name, then the server's and pg_dump's
# versions). The drill restores into that same major version and needs no
# running db, which is exactly what's missing when a restore is needed.
major="$(head -c 256 "$dump" | LC_ALL=C grep -aoE '[0-9]+\.[0-9]+' | head -1 | cut -d. -f1)" || true
[ -n "$major" ] || fail "can't read the Postgres version from $dump's header"
image="postgres:${major}-alpine"

# A run killed with kill -9 never reaches its trap: sweep what it left.
leftovers="$(docker ps -aq --filter "label=$LABEL")"
if [ -n "$leftovers" ]; then
  # shellcheck disable=SC2086
  docker rm -f -v $leftovers >/dev/null
fi

# docker run, not a compose service: compose volumes hold the dev database and
# are never touched here. No volume is named, so Docker creates an anonymous
# one for the image's data directory; rm -v (and --rm) delete it with the
# container. Unique name per run, no published port, throwaway password.
name="m_api-drill-$(date -u +%Y%m%dT%H%M%SZ)-$$"
# Keeps the exit status: without it, the cleanup's own status replaces it.
trap 'status=$?; docker rm -f -v "$name" >/dev/null 2>&1; exit $status' EXIT
docker run -d --rm --name "$name" --label "$LABEL" \
  -e POSTGRES_USER=admin -e POSTGRES_DB=shop -e POSTGRES_PASSWORD=drill-throwaway \
  "$image" >/dev/null

# Over TCP: on first start the entrypoint runs a temporary socket-only server,
# then restarts it. A socket check can pass during that phase, and the restore
# would die mid-restart.
ready=0
for _ in $(seq 1 $((READY_TIMEOUT_S * 2))); do
  if docker exec "$name" pg_isready -q -h 127.0.0.1 -U admin -d shop; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" = 1 ] || fail "the drill container wasn't ready within ${READY_TIMEOUT_S}s"

# Roles are cluster-wide, so the dump has none, but its grants name app_user and
# pgbouncer_auth. NOLOGIN roles let those grants restore faithfully with no
# passwords involved. A real recovery recreates them from init.sql's role
# section, or from a pg_dumpall --globals-only backup, which isn't taken yet.
docker exec "$name" psql -U admin -d shop -v ON_ERROR_STOP=1 -qc \
  "CREATE ROLE app_user NOLOGIN; CREATE ROLE pgbouncer_auth NOLOGIN;"

# --single-transaction: all or nothing, and it implies --exit-on-error, so a
# restore with any error stops here and never reaches the comparison.
# --no-owner: everything ends up owned by admin, which exists anyway.
restore_started_ms="$(now_ms)"
if ! docker exec -i "$name" pg_restore -U admin -d shop --no-owner --single-transaction < "$dump"; then
  fail "pg_restore failed for $dump: nothing compared"
fi
restore_ms=$(( $(now_ms) - restore_started_ms ))

# The same values, measured on the restored database, in the .check's format.
# (if, not case: bash 3.2 can't parse a case pattern's ")" inside $( ).)
actual="$(while read -r key _; do
  if [[ "$key" == *.total_cents ]]; then
    query="SELECT coalesce(sum(total_cents), 0) FROM ${key%.total_cents}"
  else
    query="SELECT count(*) FROM $key"
  fi
  echo "$key $(docker exec "$name" psql -U admin -d shop -v ON_ERROR_STOP=1 -XtAc "$query")"
done < "$dump.check")"
total_ms=$(( $(now_ms) - started_ms ))

echo "date:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "dump:     $(basename "$dump") ($(wc -c < "$dump" | tr -d ' ') bytes)"
echo "image:    $image (from the dump's header)"
echo "restore:  ${restore_ms} ms"
echo "total:    ${total_ms} ms"
echo "checked:  $(wc -l < "$dump.check" | tr -d ' ') values from $(basename "$dump").check (expected → restored)"
paste -d ' ' <(echo "$expected") <(echo "$actual" | cut -d ' ' -f 2) | awk '{ printf "  %-28s %12s → %s%s\n", $1, $2, $3, ($2 == $3 ? "" : "   ✗") }'
if [ "$actual" = "$expected" ]; then
  echo "MATCH"
else
  echo "MISMATCH"
  exit 1
fi
