#!/usr/bin/env bash
# Dumps the database in MIGRATIONS_DB_URL to backups/shop_<UTC timestamp>.dump
# (pg_dump -Fc), writes control values taken from the dump itself next to it
# (<dump>.check), and prints the dump's path as the last line. Any failure
# exits non-zero and leaves no dump behind.
# Usage: export MIGRATIONS_DB_URL=…; bash scripts/backup.sh
set -euo pipefail

# Dumps hold real data: files are readable by the owner only.
umask 077

# cron calls this from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "backup: $*" >&2
  exit 1
}

# The schema owner's direct connection, not DB_URL: app_user can't read the
# pgbouncer schema, and pg_dump needs a session that PgBouncer's transaction
# mode doesn't keep. Host, port, user and password all come from the URL, so
# the database can live anywhere this machine can reach.
url="${MIGRATIONS_DB_URL:-}"
[ -n "$url" ] || fail "MIGRATIONS_DB_URL is not set (the schema owner's direct connection)"

# The Postgres tools run in a container, where localhost is the container
# itself: a local URL is pointed at the Docker host instead.
container_url="$(printf '%s' "$url" | sed -E 's#@(localhost|127\.0\.0\.1)([:/])#@host.docker.internal\2#')"
pg() {
  docker run --rm -i --add-host host.docker.internal:host-gateway "$@"
}

# Any psql can ask the server its version; pg_dump then has to be at least the
# server's major version, so every later step uses exactly that one.
server_version="$(pg postgres:16-alpine psql "$container_url" -XtAc 'SHOW server_version_num' 2>/dev/null)" ||
  fail "can't connect to the database in MIGRATIONS_DB_URL"
image="postgres:$((server_version / 10000))-alpine"

psql_q() {
  pg "$image" psql "$container_url" -X -v ON_ERROR_STOP=1 -tAc "$1"
}

if [ "$(psql_q "SELECT to_regclass('public.orders') IS NOT NULL")" != "t" ] ||
   [ "$(psql_q "SELECT EXISTS (SELECT 1 FROM orders)")" != "t" ]; then
  fail "database is empty: run migrate and seed first"
fi

mkdir -p backups
name="shop_$(date -u +%Y%m%dT%H%M%SZ)"
dump="backups/$name.dump"
[ ! -e "$dump" ] || fail "$dump already exists"

# Written under temporary names in the same directory, renamed only after
# everything succeeded: a failed run leaves nothing that looks like a backup.
tmp_dump="$(mktemp "backups/.$name.dump.XXXXXX")"
tmp_check="$(mktemp "backups/.$name.check.XXXXXX")"
trap 'rm -f "$tmp_dump" "$tmp_check"' EXIT

# No -t: a terminal's line handling can corrupt binary output.
pg "$image" pg_dump -Fc "$container_url" > "$tmp_dump"
[ -s "$tmp_dump" ] || fail "pg_dump produced an empty file"

# Control values read back from the dump's own data, so they describe exactly
# its snapshot: one line per table with its row count, plus the sum of
# orders.total_cents. The restore drill compares the restored database to them.
pg "$image" pg_restore --data-only -f - < "$tmp_dump" | awk '
  /^COPY / {
    table = $2; rows = 0; sum = 0; money = 0
    n = split(substr($0, index($0, "(") + 1), cols, ", ")
    for (i = 1; i <= n; i++) { sub(/\).*/, "", cols[i]); if (cols[i] == "total_cents") money = i }
    next
  }
  table != "" && $0 == "\\." {
    print table, rows
    if (table == "public.orders") printf "%s.total_cents %.0f\n", table, sum
    table = ""; next
  }
  table != "" { rows++; if (money) { split($0, fields, "\t"); sum += fields[money] } }
' > "$tmp_check"
grep -q '^public\.orders ' "$tmp_check" || fail "no orders data in the dump: control values incomplete"

mv "$tmp_check" "$dump.check"
mv "$tmp_dump" "$dump"
trap - EXIT

echo "size: $(wc -c < "$dump" | tr -d ' ') bytes, Postgres ${image#postgres:}"
echo "check ($dump.check):"
sed 's/^/  /' "$dump.check"
echo "$ROOT/$dump"
