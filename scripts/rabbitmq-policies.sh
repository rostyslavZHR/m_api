#!/usr/bin/env bash
# Sets the RabbitMQ policies the topology relies on (HW#19). AMQP has no command for
# policies, so rabbitmqctl sets them inside the container: no credentials needed.
#
#   - the work queue: dead-letter-exchange, delivery-limit, and at-least-once
#     dead-lettering (which needs overflow reject-publish)
#   - the events exchange: alternate-exchange, for messages no binding matches
#
# The names come from src/messaging/topology.ts: the bootstrap (npm run
# rabbitmq:bootstrap) passes them in, so they're defined in one place:
#
#   bash scripts/rabbitmq-policies.sh <work-queue> <dead-letter-exchange> <delivery-limit> <events-exchange> <alternate-exchange>
#
# This is the dev-sized way to apply them. Policies themselves are standard in
# production; there they're usually managed as infrastructure-as-code instead: a
# definitions file imported at deploy, Terraform's RabbitMQ provider, the Kubernetes
# Messaging Topology Operator (a Policy resource), or the management HTTP API called
# from a deploy pipeline.
#
# Safe to re-run: set_policy replaces a policy of the same name. Exits non-zero on
# any failure. Each pattern is anchored to one name: a broader one (^shop\.) would
# also match the dead-letter queue, which would then dead-letter into itself. Only the
# highest-priority matching policy applies to an object; policies don't merge.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <work-queue> <dead-letter-exchange> <delivery-limit> <events-exchange> <alternate-exchange>" >&2
  exit 2
fi
WORK_QUEUE=$1 DLX=$2 DELIVERY_LIMIT=$3 EVENTS_EXCHANGE=$4 ALTERNATE_EXCHANGE=$5

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ^name$ with regex metacharacters (the dots) escaped.
anchored() { printf '^%s$' "$(printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"; }

# -T: no TTY, as under npm, a demo or the grader ("the input device is not a TTY" otherwise).
rabbitmqctl() { docker compose exec -T rabbitmq rabbitmqctl -q "$@"; }

rabbitmqctl set_policy --apply-to queues --priority 10 \
  "$WORK_QUEUE" "$(anchored "$WORK_QUEUE")" \
  "{\"dead-letter-exchange\":\"$DLX\",\"delivery-limit\":$DELIVERY_LIMIT,\"dead-letter-strategy\":\"at-least-once\",\"overflow\":\"reject-publish\"}"

rabbitmqctl set_policy --apply-to exchanges --priority 10 \
  "$EVENTS_EXCHANGE" "$(anchored "$EVENTS_EXCHANGE")" \
  "{\"alternate-exchange\":\"$ALTERNATE_EXCHANGE\"}"
