# Events service

Owns **events, their schedule (activities) and seat capacity**: RF02 (create, edit, publish, cancel events),
RF03 (schedule), RF04 (consult and search, with available seats) and the capacity half of RF06/RN01 (the waitlist
belongs to the subscription service). TypeScript on Node 22, Fastify, PostgreSQL (`events-db`, private), Kafka.

- Kind `events` in the service-discoverer (raw protocol), registered at startup and again every 30s.
- `GET /healthcheck`: 200 only when the schema is migrated and PostgreSQL answers, else 503. Kafka being down does **not** fail it.
- `GET /openapi.json`: generated from the route schemas; the gateway reads it to learn the endpoints.
- Boots even if PostgreSQL, Kafka or the discoverer are down; migration, topics, relay, consumer and registration retry in the background.

Architecture decisions specific to this service: [`docs/decisions.md`](docs/decisions.md).

## Data (Database per Service)
`events` (`DRAFT` → `PUBLISHED` → `CANCELLED`, or `DRAFT` → `CANCELLED`) · `activities` (schedule items: period,
speaker, location, `capacity`, `reserved`, `price_cents`, `waitlist_enabled`) · `seat_reservations` (one row per
registration that held a seat) · `processed_messages` (idempotent consumer) · `outbox` (transactional outbox).
Invariants enforced by the database: `0 <= reserved <= capacity` (no overbooking), capacity immutable (trigger), periods
valid. Prices are integers in cents of BRL; `paid = price_cents > 0`, `available = capacity - reserved` (generated columns).

## HTTP API (through the gateway: `/events/...`)
Changes need `Authorization: Bearer <access token>` issued by the user service (RS256, verified here against its JWKS;
`X-User-Id` is ignored). Reads are public; with a token, an organizer also sees their own drafts.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /events?q=&from=&to=&limit=&offset=` | anyone | Published events; `q` searches title, description, organization, location |
| `GET /events/{eventId}` | anyone* | Event + schedule with `capacity`/`available` per activity |
| `GET /events/{eventId}/activities` | anyone* | Schedule only |
| `GET /activities/{activityId}` | anyone* | One activity |
| `GET /me/events` | token | Caller's events, any status |
| `POST /events` | `ORGANIZER` role | Creates a `DRAFT`; 201 |
| `PATCH /events/{eventId}` | owner | Partial; not when cancelled; activities must stay inside the new period |
| `POST /events/{eventId}/publish` | owner | Draft with ≥1 activity that has not ended |
| `POST /events/{eventId}/cancel` | owner | Final |
| `POST /events/{eventId}/activities` | owner | Inside the event period; `capacity` 1..100000; 201 |
| `PATCH /activities/{activityId}` | owner | `capacity` is rejected (immutable); `price_cents` only while draft |
| `DELETE /activities/{activityId}` | owner | Only while draft; 204 |

\* drafts are visible only to their organizer. Someone else's event is a **404**, same as a missing one (RN07).
`publish`/`cancel` take no body: do not send `Content-Type: application/json` without a body (Fastify answers 400).

Errors are `application/problem+json` (same as the user service): `{type, title, status, detail, code, traceId, errors?}`.
Codes: `VALIDATION_ERROR` (400, unknown fields included), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`INVALID_STATUS` / `EVENT_CANCELLED` / `EVENT_NOT_DRAFT` / `EVENT_WITHOUT_ACTIVITIES` / `EVENT_ENDED` (409),
`INVALID_PERIOD` / `ACTIVITY_OUTSIDE_EVENT` (422), `AUTH_UNAVAILABLE` (503: no token key cached and the user service is
unreachable), `INTERNAL_ERROR` (500, details only in the log). `traceId` is the request id: the gateway's `X-Request-Id`
when well formed, echoed in the `X-Request-Id` response header and in the logs.

Rollout: the gateway adds new endpoints as private. Open them once with `events/scripts/register-gateway-routes.sh`
(instructions in its header).

## Messages
Same envelope as the rest of the bus (the one the reports service consumes):
`{"message_id","type","version":1,"occurred_at","correlation_id","data":{...}}`. `message_id` is stable on resend, so
consumers deduplicate with it; `correlation_id` is the HTTP request id (or the incoming message's), to follow a
registration across services.

**Published** on `EVENTS_TOPIC` (`events-events`) through the transactional outbox (at-least-once, in commit order):

| `type` | Key | `data` |
|---|---|---|
| `event.created` / `updated` / `published` / `cancelled` | `event_id` | `event_id, organizer_id, organization, name, status, starts_at, ends_at` |
| `activity.created` / `updated` / `deleted` | `event_id` | `activity_id, event_id, name, starts_at, ends_at, capacity, available, price_cents, currency, paid, waitlist_enabled` |
| `seat.reserved` | `registration_id` | `registration_id, event_id, activity_id, user_id, price_cents, currency, paid, available` |
| `seat.rejected` | `registration_id` | same ids + `reason` (`FULL`, `ACTIVITY_NOT_FOUND`, `EVENT_NOT_OPEN`, `REGISTRATION_CLOSED`), `waitlist_enabled` |
| `seat.released` | `registration_id` | same ids + `available`, `waitlist_enabled` |

**Consumed** from `SUBSCRIPTION_TOPIC` (`subscription-events`), consumer group `events-service` (other types are ignored):

| `type` | Effect |
|---|---|
| `registration.requested` (`registration_id, event_id, activity_id, user_id?`) | Takes a seat → `seat.reserved`, or `seat.rejected` |
| `registration.cancelled` / `registration.expired` (same fields) | Frees the seat if the registration held one → `seat.released` |

Seat saga (choreography) as the subscription service is expected to play it: on `seat.reserved` with `paid=false` confirm
the registration; with `paid=true` start the payment and, on refusal or expiry (RN02/RN03), publish
`registration.expired`/`cancelled` so the seat is freed. On `seat.rejected` with `FULL` and `waitlist_enabled`, waitlist it;
on `seat.released` offer the seat to the next waitlisted registration by publishing its `registration.requested` (RN04).
On `event.cancelled`, cancel the event's registrations. Each registration is answered in order (key = `registration_id`);
a retried request for a registration that already holds a seat gets `seat.reserved` again without taking a second one.

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
