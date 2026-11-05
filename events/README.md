# Events service

Owns **events, their schedule (activities), the maximum capacity of each activity and the activity lifecycle**: RF02
(create, edit, publish, cancel events), RF03 (schedule), RF04 (consult and search) and the capacity half of RF06/RN01.
The seats taken, the registrations and the waitlist belong to the subscription service: Events only keeps the maximum
`capacity`. TypeScript on Node 22, Fastify, PostgreSQL (`events-db`, private), Kafka (producer only).

- Kind `events` in the service-discoverer through the shared TypeScript lib (`service-discoverer/Libs/typescript`, package `discovery`), registered once at startup with the lib's default retries.
- `GET /healthcheck`: 200 only when the schema is migrated and PostgreSQL answers, else 503. Kafka being down does **not** fail it.
- `GET /openapi.json`: generated from the route schemas; the gateway reads it to learn the endpoints.
- Boots even if PostgreSQL, Kafka or the discoverer are down; migration, topics, relay and the automatic end retry in the background; registration is attempted once (lib defaults).

Contracts: [`docs/contracts.md`](docs/contracts.md). Architecture decisions: [`docs/decisions.md`](docs/decisions.md).

## Data (Database per Service)
`events` (`DRAFT` → `PUBLISHED` → `CANCELLED`, or `DRAFT` → `CANCELLED`) · `activities` (schedule items: period,
speaker, location, `capacity`, `price_cents`, `waitlist_enabled`, `ended_at`) · `outbox` (transactional outbox).
Invariants enforced by the database: capacity immutable (trigger), periods valid. Amounts are integers in cents of BRL
(`price_cents` in the database, `amount_minor` in the API and the messages); `paid = price_cents > 0` (generated column).
The migration is non-destructive: the legacy `reserved` and `available` columns and the `seat_reservations` and
`processed_messages` tables of the old seat saga stay in the database, unused (nothing reads or writes them).

**Activity lifecycle**, derived and never stored: `CANCELLED` if its event is cancelled, else `ENDED` if `ended_at` is set,
else `OPEN`. An activity is ended by its organizer (`POST /api/v1/activities/{activity_id}/end`, only after its scheduled
`ends_at`) or automatically `ACTIVITY_AUTO_END_AFTER_SECONDS` after `ends_at`; either way `ActivityEnded` is published.
Cancelling the event publishes `ActivityCancelled` for each activity that had not ended. Ended and cancelled activities stay
consultable.

## Contracts
The full HTTP and Kafka contracts, with field rules, error codes and examples, are in [`docs/contracts.md`](docs/contracts.md)
(`GET /openapi.json` is the executable source of the HTTP part). In short:

- **Identity**: only the gateway's headers, `X-User-Id` (the user UUID; present but invalid is a 401) and `X-User-Roles`
  (comma separated). There is no token handling here; the service trusts the headers because it is reachable only through
  the gateway and the internal network. Without `X-User-Id` the caller is anonymous (fine for public reads); changes and
  `/me/events` answer 401 `UNAUTHENTICATED`.
- **HTTP** (all under `/api/v1`; through the gateway: `/events/api/v1/...`): public reads `GET /api/v1/events` (search),
  `GET /api/v1/events/{event_id}`, `GET /api/v1/events/{event_id}/activities`, `GET /api/v1/activities/{activity_id}`;
  with identity `GET /api/v1/me/events`; organizer changes `POST /api/v1/events`, `PATCH /api/v1/events/{event_id}`,
  `POST /api/v1/events/{event_id}/publish|cancel`, `POST /api/v1/events/{event_id}/activities`,
  `PATCH|DELETE /api/v1/activities/{activity_id}`, `POST /api/v1/activities/{activity_id}/end`. Subscription calls
  `GET /api/v1/activities/{activity_id}/permissions/me` (`{"can_manage": bool}`) through the discoverer; it is not opened on
  the gateway. Someone else's event is a 404 (RN07). Errors are `application/problem+json` with `code` and `traceId`.
- **Publishes** on `events.events` (transactional outbox), flat envelope like Subscription's (`message_id`,
  `schema_version`, `type`, `occurred_at`, `trace_id`, fields at the top level): `EventCreated|Updated|Published|Cancelled` and
  `ActivityCreated|Updated|Deleted` keyed by `event_id`; `ActivityEnded` and `ActivityCancelled` keyed by `activity_id`.
- **Consumes nothing.**

Rollout: the gateway adds new endpoints as private. Open them once with `events/scripts/register-gateway-routes.sh`
(instructions in its header).

## Env
`PORT` (8080), `DATABASE_URL` (`postgres://events:events@events-db:5432/events`, dev default), `KAFKA_BROKERS` (`kafka:9092`),
`EVENTS_TOPIC` (`events.events`), `EVENTS_TOPIC_PARTITIONS` (6), `OUTBOX_INTERVAL_MS` (500), `OUTBOX_BATCH_SIZE` (100),
`OUTBOX_RETENTION_HOURS` (24), `ACTIVITY_AUTO_END_AFTER_SECONDS` (86400, positive integer: how long after its scheduled
`ends_at` an activity nobody ended is ended automatically; the job runs every 60 s).
The `discovery` lib itself reads `SERVICE_DISCOVERER_URL` and `SERVICE_HOST` (default `<hostname>:<PORT>`).
`EVENTS_DB_PASSWORD` (compose) sets the database password; the root compose passes it to `DATABASE_URL` too.
Gone with the seat saga and the token check: `SUBSCRIPTION_TOPIC`, `EVENTS_CONSUMER_GROUP`, `JWT_ISSUER`, `JWT_JWKS_URL`,
`JWKS_CACHE_SECONDS` (ignored if still set).

## Tests
    npm install
    npm test                      # unit (node:test, no network, no database): rules, identity, API, lifecycle, auto end, messages, config
    docker run -d --name events-test-db -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16-alpine
    TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration

The unit tests run the real use cases, routes and job over an in-memory stand-in for the database (`test/fakes.ts`). The
integration suite runs them against PostgreSQL: lifecycle and authorization, the end and automatic end (real SQL, `SKIP LOCKED`),
outbox and relay.
