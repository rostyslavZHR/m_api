#!/bin/sh
# The edge's own key (HW#26 Phase E): read-only on the bucket, so a leak of the edge's
# credentials can't write or delete anything. Run once per store start by the
# garage-edge-key service in docker-compose.yml, through Garage's admin API (the image has
# no shell, this curl image does).
#
# Idempotent: Garage refuses to import a key id twice (409, even after a delete), so the
# key is imported only if it isn't there yet; granting read is idempotent by itself. A
# second `up`, or a re-run, changes nothing.
set -eu

api="http://garage:3903/v2"
auth="Authorization: Bearer ${GARAGE_ADMIN_TOKEN}"

status=$(curl -s -o /dev/null -w '%{http_code}' -H "$auth" "$api/GetKeyInfo?id=${EDGE_KEY_ID}")
if [ "$status" = 200 ]; then
  echo "edge key: already there"
else
  curl -sf -o /dev/null -H "$auth" -H 'Content-Type: application/json' \
    -d "{\"accessKeyId\":\"${EDGE_KEY_ID}\",\"secretAccessKey\":\"${EDGE_SECRET_KEY}\",\"name\":\"edge\"}" \
    "$api/ImportKey"
  echo "edge key: imported"
fi

# The bucket's id (64 hex characters), wherever it sits in the (pretty-printed) JSON.
bucket_id=$(curl -sf -H "$auth" "$api/GetBucketInfo?globalAlias=${BUCKET}" | grep -o '"id": *"[0-9a-f]\{64\}"' | head -1 | grep -o '[0-9a-f]\{64\}')
[ -n "$bucket_id" ] || { echo "bucket ${BUCKET} not found"; exit 1; }

# Read only: no write, no owner.
curl -sf -o /dev/null -H "$auth" -H 'Content-Type: application/json' \
  -d "{\"bucketId\":\"${bucket_id}\",\"accessKeyId\":\"${EDGE_KEY_ID}\",\"permissions\":{\"read\":true}}" \
  "$api/AllowBucketKey"
echo "edge key: read on ${BUCKET}"

# Stay up and report healthy (the compose healthcheck looks for this file): `docker compose
# up --wait` treats any exited container as a failure, even exit 0, so a one-shot that
# finished would fail the whole `up`. Sleeping costs nothing, and compose restarts this
# service whenever garage restarts (depends_on … restart: true), re-running the setup.
touch /tmp/edge-key-ready
exec sleep infinity
