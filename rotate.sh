#!/usr/bin/env bash
# Rotate app_user's password without restarting the app.
#
# Order matters:
#   1. ALTER ROLE in the DB (new password becomes the source of truth);
#   2. write the secret file immediately after (new connections pick up
#      the new password);
#   3. terminate OLD app_user connections — forces the next request to
#      open a fresh connection, which will use the new password.
#
# There's a millisecond window between 1 and 2 where a brand-new connection
# using the still-old file would fail. Production secret managers (AWS
# Secrets Manager rotation, Vault's database engine) avoid this entirely by
# alternating between two live users instead of one.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

NEW_PASSWORD="app-$(openssl rand -hex 8)"

echo "1. ALTER ROLE in Postgres..."
docker compose exec -T db psql -U admin -d shop \
  -c "ALTER ROLE app_user WITH PASSWORD '${NEW_PASSWORD}';" >/dev/null

echo "2. Writing secret file..."
printf '%s' "${NEW_PASSWORD}" > secrets/db_password

echo "3. Terminating old app_user connections..."
docker compose exec -T db psql -U admin -d shop -tA \
  -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = 'app_user' AND pid <> pg_backend_pid();"

echo "Done: new password ${NEW_PASSWORD:0:6}... is now live in both the DB and the file."
echo "App was not restarted — verify with: curl -s localhost:3000/db"
