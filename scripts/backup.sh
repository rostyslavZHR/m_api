#!/usr/bin/env bash
# Dumps the shop database to backups/shop_<UTC timestamp>.dump (pg_dump -Fc),
# writes control values next to it (<dump>.check), and prints the dump's path
# as the last line. Any failure exits non-zero and leaves no dump behind.
# Usage: export DB_URL=…; bash scripts/backup.sh
set -euo pipefail

# Dumps hold real data: files are readable by the owner only.
umask 077

# cron calls this from anywhere; compose needs the repo root.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Only the database name is taken from the URL. Host, port, user and password
# are ignored: the dump runs inside the db container as its superuser, over the
# local socket, so no credentials appear here.
url="${DB_URL:-${DATABASE_URL:-}}"
if [ -z "$url" ]; then
  echo "backup: neither DB_URL nor DATABASE_URL is set" >&2
  exit 1
fi
db="${url##*/}"
db="${db%%\?*}"
if [ -z "$db" ]; then
  echo "backup: no database name in the connection URL" >&2
  exit 1
fi

# Runs psql as the container's superuser. Single quotes: the container's shell
# expands $POSTGRES_USER, not this one. The database name goes in as $1.
psql_in_db() {
  docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -tAc "$2"' sh "$db" "$1"
}

if ! docker compose exec -T db pg_isready -q; then
  echo "backup: can't reach the db container (is 'docker compose up' running?)" >&2
  exit 1
fi

if [ "$(psql_in_db "SELECT to_regclass('public.orders') IS NOT NULL")" != "t" ] ||
   [ "$(psql_in_db "SELECT EXISTS (SELECT 1 FROM orders)")" != "t" ]; then
  echo "backup: database is empty: run migrate and seed first" >&2
  exit 1
fi

mkdir -p backups
name="shop_$(date -u +%Y%m%dT%H%M%SZ)"
dump="backups/$name.dump"
if [ -e "$dump" ]; then
  echo "backup: $dump already exists" >&2
  exit 1
fi

# Written under temporary names in the same directory, renamed only after
# pg_dump succeeds: a failed run leaves nothing that looks like a backup.
tmp_dump="$(mktemp "backups/.$name.dump.XXXXXX")"
tmp_check="$(mktemp "backups/.$name.check.XXXXXX")"
trap 'rm -f "$tmp_dump" "$tmp_check"' EXIT

# Phase F compares the restored database against these, not the live one.
# They're read just before the dump, so writes in between would make them
# differ; nothing writes to shop while a backup runs here.
psql_in_db "SELECT count(*) || '|' || sum(total_cents) FROM orders" > "$tmp_check"

# -T: no terminal. A terminal's line handling can corrupt binary output, and
# pg_restore then rejects the file. pg_dump is the container's own Postgres 16.
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$1" -Fc' sh "$db" > "$tmp_dump"

if [ ! -s "$tmp_dump" ]; then
  echo "backup: pg_dump produced an empty file" >&2
  exit 1
fi

mv "$tmp_check" "$dump.check"
mv "$tmp_dump" "$dump"
trap - EXIT

echo "size: $(wc -c < "$dump" | tr -d ' ') bytes"
echo "check (orders count|sum total_cents): $(cat "$dump.check")"
echo "$ROOT/$dump"
