#!/bin/sh
# Demo of the seat saga without the subscription service: publishes a registration.requested (or
# registration.cancelled) message the way the subscription service will, then shows the events service's
# answers (seat.reserved / seat.rejected / seat.released) on the events topic.
#
#   events/scripts/demo-seat-request.sh <event_id> <activity_id> [registration_id] [requested|cancelled|expired]
#
# Run from the repository root with the compose project up. Reusing a registration_id shows idempotency
# (ALREADY_HELD) and lets you cancel it afterwards.
set -eu
EVENT_ID=${1:?event_id}
ACTIVITY_ID=${2:?activity_id}
REGISTRATION_ID=${3:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)}
ACTION=${4:-requested}
MESSAGE_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
KAFKA_BIN=/opt/kafka/bin

MESSAGE="{\"message_id\":\"$MESSAGE_ID\",\"type\":\"registration.$ACTION\",\"version\":1,\"occurred_at\":\"$NOW\",\"correlation_id\":\"demo-$MESSAGE_ID\",\"data\":{\"registration_id\":\"$REGISTRATION_ID\",\"event_id\":\"$EVENT_ID\",\"activity_id\":\"$ACTIVITY_ID\",\"user_id\":\"demo-user\"}}"

echo "registration $REGISTRATION_ID: sending registration.$ACTION"
echo "$REGISTRATION_ID|$MESSAGE" | docker compose exec -T kafka $KAFKA_BIN/kafka-console-producer.sh \
  --bootstrap-server localhost:9092 --topic subscription-events --property parse.key=true --property key.separator='|'

echo "answers on events-events for this registration (waiting up to 10s):"
docker compose exec -T kafka $KAFKA_BIN/kafka-console-consumer.sh --bootstrap-server localhost:9092 \
  --topic events-events --from-beginning --timeout-ms 10000 2>/dev/null | grep "\"registration_id\":\"$REGISTRATION_ID\"" || true
