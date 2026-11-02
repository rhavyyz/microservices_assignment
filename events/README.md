# Events service

Owns **events, their schedule (activities) and seat capacity**: RF02 (create, edit, publish, cancel events),
RF03 (schedule), RF04 (consult and search, with available seats) and the capacity half of RF06/RN01 (the waitlist
belongs to the subscription service). TypeScript on Node 22, Fastify, PostgreSQL (`events-db`, private), Kafka.

- Kind `events` in the service-discoverer (raw protocol), registered at startup and again every 30s.
- `GET /healthcheck`: 200 only when the schema is migrated and PostgreSQL answers, else 503. Kafka being down does **not** fail it.
- `GET /openapi.json`: generated from the route schemas; the gateway reads it to learn the endpoints.
- Boots even if PostgreSQL, Kafka or the discoverer are down; migration, topics, relay, consumer and registration retry in the background.

Contracts: [`docs/contracts.md`](docs/contracts.md). Architecture decisions: [`docs/decisions.md`](docs/decisions.md).

## Data (Database per Service)
`events` (`DRAFT` → `PUBLISHED` → `CANCELLED`, or `DRAFT` → `CANCELLED`) · `activities` (schedule items: period,
speaker, location, `capacity`, `reserved`, `price_cents`, `waitlist_enabled`) · `seat_reservations` (one row per
registration that held a seat) · `processed_messages` (idempotent consumer) · `outbox` (transactional outbox).
Invariants enforced by the database: `0 <= reserved <= capacity` (no overbooking), capacity immutable (trigger), periods
valid. Prices are integers in cents of BRL; `paid = price_cents > 0`, `available = capacity - reserved` (generated columns).

## Contracts
The full HTTP and Kafka contracts, with field rules, error codes and examples, are in [`docs/contracts.md`](docs/contracts.md)
(`GET /openapi.json` is the executable source of the HTTP part). In short:

- **HTTP** (through the gateway: `/events/...`): public reads `GET /events` (search), `GET /events/{eventId}`,
  `GET /events/{eventId}/activities`, `GET /activities/{activityId}`; with a token `GET /me/events`; organizer changes
  `POST /events`, `PATCH /events/{eventId}`, `POST /events/{eventId}/publish|cancel`, `POST /events/{eventId}/activities`,
  `PATCH|DELETE /activities/{activityId}`. Changes need `Authorization: Bearer <token>` from the user service; someone
  else's event is a 404 (RN07). Errors are `application/problem+json` with `code` and `traceId`.
- **Publishes** on `events-events` (transactional outbox): `event.*`, `activity.*` keyed by `event_id`; `seat.reserved`,
  `seat.rejected`, `seat.released` keyed by `registration_id`.
- **Consumes** from `subscription-events`: `registration.requested` (takes a seat), `registration.cancelled` /
  `registration.expired` (frees it), each message applied once.

Rollout: the gateway adds new endpoints as private. Open them once with `events/scripts/register-gateway-routes.sh`
(instructions in its header).

## Env
`PORT` (8080), `DATABASE_URL` (`postgres://events:events@events-db:5432/events`, dev default), `KAFKA_BROKERS` (`kafka:9092`),
`EVENTS_TOPIC`, `SUBSCRIPTION_TOPIC`, `EVENTS_CONSUMER_GROUP` (`events-service`), `EVENTS_TOPIC_PARTITIONS` (6),
`OUTBOX_INTERVAL_MS` (500), `OUTBOX_BATCH_SIZE` (100), `OUTBOX_RETENTION_HOURS` (24), `JWT_ISSUER` (`eventhub-users`),
`JWT_JWKS_URL` (default: the user service found through the discoverer, `/.well-known/jwks.json`), `JWKS_CACHE_SECONDS` (300),
`SERVICE_DISCOVERER_URL`, `SERVICE_HOST` (`<hostname>:<PORT>`), `REREGISTER_INTERVAL_MS` (30000).
`EVENTS_DB_PASSWORD` (compose) sets the database password; the root compose passes it to `DATABASE_URL` too.

## Tests
    npm install
    npm test                      # unit (node:test): rules, messages, token verification, errors, discovery, consumer
    docker run -d --name events-test-db -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16-alpine
    TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration

The integration suite runs the real use cases against PostgreSQL: lifecycle and authorization, outbox and relay, and the
concurrency test of RN01 (200 simultaneous requests for 25 seats: exactly 25 reserved, 175 `FULL`).

Demo of the seat saga with the compose project up (plays the subscription service over Kafka):

    events/scripts/demo-seat-request.sh <event_id> <activity_id>                     # -> seat.reserved / seat.rejected
    events/scripts/demo-seat-request.sh <event_id> <activity_id> <registration_id> cancelled   # -> seat.released
