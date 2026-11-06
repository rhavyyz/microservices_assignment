# Reports service

Read-only indicators for organizers (RF11): registrations, payments, occupancy and attendance per event and per activity.
It never reads another service's database: it builds its own read model (PostgreSQL `reports-db`) from Kafka events.

- Kind `reports`, registered in the service-discoverer with the shared TypeScript lib (`discovery`, `service-discoverer/Libs/typescript`, linked as a `file:` dependency).
- `GET /healthcheck`: 503 until the first migration succeeded, and 503 whenever the Postgres ping fails; 200 otherwise. Body `{"status":"ok"|"unavailable"}`. Kafka being down does **not** fail it (RQ03).
- `GET /openapi.json`: generated from the routes; the gateway reads it at startup. Private: `/healthcheck` declares `isPublic: false`.
- Boots even if Postgres, Kafka or the discoverer are down; migration, consumer and registration retry in the background.

## Endpoints (through the gateway: `/reports/...`)
All need `X-User-Id`. The caller must be the `organizer_id` of the event (taken from the `Event*` messages);
anything else is a 404, same as an unknown event (RN07).

**Identity.** `X-User-Id` (set by the gateway from the verified JWT) must be a UUID; missing or malformed is a 401 `UNAUTHENTICATED`.
`X-User-Roles` is not used: the only access rule is ownership of the event (no administrator profile). A path id (`eventId`) that is
not a UUID gets the same 404 `EVENT_NOT_FOUND` as an unknown or someone else's event, without touching the database.

**Trace id.** The inbound `X-Trace-Id` is kept only when it matches `^[A-Za-z0-9._-]{8,64}$`; otherwise a UUID is generated. It is the
request id in the logs, the `traceId` of error bodies and the `X-Trace-Id` header of every response. `X-Request-Id` and `X-Correlation-Id` are ignored.

**Errors.** Every error is `application/problem+json` with `{title, status, code, detail?, traceId}` (`traceId` = the request's trace id):

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | invalid query parameter (`limit`, `offset`) |
| 401 | `UNAUTHENTICATED` | `X-User-Id` missing or not a UUID |
| 404 | `EVENT_NOT_FOUND` | unknown event, not a UUID, or not owned by the caller (indistinguishable) |
| 404 | `NOT_FOUND` | unknown route |
| 500 | `INTERNAL_ERROR` | anything unexpected; no internals in the body (they stay in the log) |

    {"title":"Not Found","status":404,"code":"EVENT_NOT_FOUND","detail":"event not found","traceId":"8c1f0f3e-5c1c-4d63-9a2e-2f5f4d2b7a10"}

`/healthcheck` keeps its own body (`{"status":"ok"}` / `{"status":"unavailable"}`) because the discoverer polls the status code.

**Pagination.** `GET /events` and `GET /events/{eventId}/activities` accept `limit` (1-100, default 20) and `offset` (>= 0, default 0) and
return `{"items":[...],"total":N,"limit":20,"offset":0}`; `total` is the number of rows before paging. The item shapes are unchanged.
Out-of-range or non-integer values are a 400 `VALIDATION_ERROR`.

| Endpoint | Returns |
|---|---|
| `GET /events` | Events owned by the caller (paginated) |
| `GET /events/{eventId}/summary` | Event + registrations + payments + occupancy + attendance + `activities` (counts by lifecycle) |
| `GET /events/{eventId}/activities` | Per-activity indicators (paginated) + `activities` (counts by lifecycle) |
| `GET /events/{eventId}/registrations` | Counts by status (`pending_payment`, `offered`, `confirmed`, `waitlisted`, `cancelled`, `expired`, `rejected`, `total`) |
| `GET /events/{eventId}/payments` | Counts by status + `revenue` and `refunded` lists by currency |
| `GET /events/{eventId}/attendance` | `confirmed`, `checkins`, `rate`, `certificate_eligible`, `certificate_eligible_rate` |

Definitions: **occupied** (held seats) = `PENDING_PAYMENT` + `OFFERED` + `CONFIRMED` registrations (a pending payment and an offered seat both hold a seat in Subscription; `WAITLISTED` holds none);
**occupancy rate** = occupied / sum of activity capacities; **attendance rate** = counted check-ins / confirmed registrations.
Rates are `null` when the denominator is 0.

**Capacity rule.** Activities whose lifecycle is `CANCELLED` or `DELETED` do not count toward the event's capacity or any capacity-based rate
(the seats held by registrations of those activities are not counted as occupied either, so the rate stays coherent). A `CANCELLED` activity
in the per-activity list keeps its `capacity` but has `occupancy_rate: null`.

**Check-in rule.** A check-in counts only while its registration is currently `CONFIRMED` (joined at query time on `registration_id`), in the
summary, the attendance route and the per-activity figures. A check-in whose registration was cancelled later stops counting; one whose
registration is not known yet is not counted until it arrives as `CONFIRMED`. So `attendance_rate` never exceeds 1. The `checkins` table and its
handler are unchanged (insert-only), which keeps the projection replay-safe and order-independent.

**Activity lifecycle.** `activities.lifecycle` is `OPEN`, `ENDED`, `CANCELLED` or `DELETED`. The activity list carries `lifecycle` and `ended_at`
(set from the `ActivityEnded` message's `occurred_at`, else `null`); `DELETED` activities appear in no list or total (`items`/`total` of `/activities`
exclude them). `activities: {"open":N,"ended":N,"cancelled":N}` (deleted excluded) is returned by the summary and by `/activities`.

**Certificate eligibility.** `certificate_eligible` = number of people with an `AttendanceEligible` for the event; `certificate_eligible_rate` =
`certificate_eligible` / distinct people with at least one counted check-in (`null` when that is 0).

    "attendance": {"confirmed":4,"checkins":3,"rate":0.75,"certificate_eligible":2,"certificate_eligible_rate":0.6667}
    "activities": {"open":1,"ended":2,"cancelled":1}

Money is integer minor units (cents) grouped by currency, never summed across currencies. `revenue` is the sum of `APPROVED`
payments, `refunded` the sum of `REFUNDED` ones; payments without a currency are grouped as `"UNKNOWN"`; both are empty lists when there is nothing:

    "payments": {"pending":1,"approved":2,"declined":0,"expired":0,"cancelled":0,"refunded_count":1,
                 "revenue":[{"currency":"BRL","amount_minor":2500},{"currency":"USD","amount_minor":1000}],
                 "refunded":[{"currency":"BRL","amount_minor":700}]}

`GET /events/{eventId}/activities` items carry the same registration counters, `payments_approved`, `revenue` and `refunded`.

API change (breaking): `GET /events` and `GET /events/{eventId}/activities` now return `{items,total,limit,offset}` instead of `{items}` and
return only the first 20 items unless `limit`/`offset` say otherwise (page through with `offset`). Errors are now `application/problem+json` (they used to be `{"error": "..."}` or plain text).
Also: `registrations.pending` is now `pending_payment` (and `offered`, `rejected` are new); `payments.confirmed`/`refused` are
now `approved`/`declined` (`refunded_count` is new); the numeric `payments.revenue` is now the list above; per activity `pending` -> `pending_payment`,
`payments_confirmed` -> `payments_approved`, and numeric `revenue` -> list.

Gateway: each business operation of `/openapi.json` declares its settings with the gateway's `x-gateway` extension, so no manual
admin call is needed. The gateway applies it when it first creates the endpoint (insert-only; later changes go through its admin API):

    "x-gateway": {"isPublic": true, "requireAuth": true}

All six routes declare it (rate limits are left to the gateway's defaults). `/healthcheck` declares `{"isPublic": false, "requireAuth": false}`
and `/openapi.json` is hidden from the spec, so both stay private (404 through the gateway). The OpenAPI also
documents the `X-User-Id` header (security scheme `userId`) and the problem responses of each route.

## Event contract (what the other services publish)
Topics (one per producer, key set by the producer, e.g. `event_id`, `activity_id` or `registration_id`, so related messages stay ordered):
`events.events` (events service), `subscription.events` (subscription), `payments.events` (payments).
Names are configurable (`EVENTS_TOPIC`, `SUBSCRIPTION_TOPIC`, `PAYMENTS_TOPIC`). The consumer group is `reports-service`.

Flat envelope (JSON): the type's fields sit at the top level, next to the envelope fields. There is no nested `data` object
(the old format is rejected). `schema_version` must be 1 (missing counts as 1; greater is rejected).

    {"message_id":"uuid","schema_version":1,"type":"PaymentApproved","occurred_at":"2026-10-31T12:00:00.000-03:00",
     "trace_id":null,"payment_id":"uuid","registration_id":"uuid","user_id":"uuid","event_id":"uuid","activity_id":"uuid",
     "amount_minor":2500,"currency":"BRL","status":"APPROVED","reason":null}

| `type` | Producer | Required | Optional |
|---|---|---|---|
| `EventCreated`, `EventUpdated` | events | `event_id` | `organizer_id`, `name`, `status`, `starts_at`, `ends_at` |
| `EventPublished`, `EventCancelled` | events | `event_id` | same (status is forced to `PUBLISHED` / `CANCELLED`) |
| `ActivityCreated`, `ActivityUpdated` | events | `activity_id`, `event_id` | `name`, `capacity`, `paid` |
| `ActivityEnded`, `ActivityCancelled` | events | `activity_id`, `event_id` | `ends_at` (unused) |
| `ActivityDeleted` | events | `activity_id`, `event_id` | the other activity fields (unused) |
| `RegistrationWaitlisted`, `WaitlistOffered`, `RegistrationPendingPayment`, `RegistrationConfirmed`, `RegistrationCancelled`, `RegistrationExpired`, `RegistrationRejected` | subscription | `registration_id`, `event_id`, `activity_id` | `user_id` |
| `AttendanceRecorded` (check-in) | subscription | `registration_id`, `event_id`, `activity_id` | `user_id` |
| `AttendanceEligible` | subscription | `event_id`, `user_id`, `attended_activities`, `total_activities`, `attendance_percentage` | `registration_id`, `activity_id` |
| `PaymentCreated`, `PaymentApproved`, `PaymentDeclined`, `PaymentExpired`, `PaymentCancelled`, `PaymentRefunded` | payments | `payment_id`, `event_id` | `registration_id`, `activity_id`, `amount_minor`, `currency` |

Type to stored status (the read model keeps only the latest state of each registration and payment):

| Registration type | Status | Payment type | Status |
|---|---|---|---|
| `RegistrationWaitlisted` | `WAITLISTED` | `PaymentCreated` | `PENDING` |
| `WaitlistOffered` | `OFFERED` | `PaymentApproved` | `APPROVED` |
| `RegistrationPendingPayment` | `PENDING_PAYMENT` | `PaymentDeclined` | `DECLINED` |
| `RegistrationConfirmed` | `CONFIRMED` | `PaymentExpired` | `EXPIRED` |
| `RegistrationCancelled` | `CANCELLED` | `PaymentCancelled` | `CANCELLED` |
| `RegistrationExpired` | `EXPIRED` | `PaymentRefunded` | `REFUNDED` (no longer `APPROVED`) |
| `RegistrationRejected` | `REJECTED` | | |

Money: payments send `amount_minor`, an integer in minor units (cents). Reports stores it as is in `payments.amount_minor` (`bigint`);
a negative, fractional, string or unsafe-integer value invalidates the message. The old decimal `payments.amount` column is kept but unused.
Migrations (idempotent, run at startup) rename the stored statuses (`PENDING` -> `PENDING_PAYMENT` for registrations, `CONFIRMED` -> `APPROVED`
and `REFUSED` -> `DECLINED` for payments) and backfill `amount_minor` from `amount`.

Registration and check-in messages must carry `event_id` (invalid otherwise: `event_id is required`).

Dead-letter queue: `reports.dlq` (`REPORTS_DLQ_TOPIC`), created at startup like the input topics (create-if-absent, same partitions).
An INVALID message (empty, unparsable JSON, contract violation, unsupported `schema_version`) is published there as a reference only,
never the payload, and the offset advances; the record is keyed `<source_topic>:<partition>`:

    {"source_topic":"payments.events","partition":3,"offset":42,"reason":"PaymentApproved: payment_id is required"}

Unknown or ignored types are not dead-lettered. If the DLQ publish fails (the producer connects in the background, or Kafka is down), the
handler throws, the offset is not committed and the message is redelivered, so no reference is lost.

`AttendanceEligible` validation: `attended_activities` and `total_activities` are non-negative integers, `total_activities >= 1`,
`attended_activities <= total_activities`, `attendance_percentage` a finite number in [0, 100]; otherwise the message is invalid (DLQ).
One row per (`event_id`, `user_id`) in `attendance_eligibility`, kept with the same `last_event_at` guard as the other tables (an older message never
overwrites a newer one; a missing `registration_id` keeps the stored one).

Activity lifecycle messages (`ActivityEnded` -> `ENDED`, `ActivityCancelled` -> `CANCELLED`, `ActivityDeleted` -> `DELETED`) update only
`lifecycle` (and `ended_at` for `ENDED`), never the descriptive fields or their `last_event_at`.
- **Rank rule.** The lifecycle only moves forward: `OPEN` < `ENDED` < `CANCELLED` < `DELETED`. A message of lower or equal rank is a no-op, so a late
  `ActivityEnded` after `ActivityCancelled` changes nothing and applying a message twice changes nothing. `ended_at` is the first `ENDED`'s `occurred_at`.
- **Stub rows.** These messages are keyed differently from `ActivityCreated` (by `activity_id` vs `event_id`), so they can arrive first. An unknown
  activity is then inserted as a stub (`event_id` from the message, `name`/`capacity` `NULL`, `paid` false, `last_event_at = 'epoch'`), and any later
  `ActivityCreated`/`ActivityUpdated` fills the descriptive fields. That upsert never touches `lifecycle`, so the lifecycle is not reset either.
  Until then the stub is listed (unless `DELETED`) with a `null` name and capacity.

Migration SQL added (idempotent, appended to the existing statements):

    ALTER TABLE activities ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'OPEN';
    ALTER TABLE activities ADD COLUMN IF NOT EXISTS ended_at timestamptz;
    CREATE TABLE IF NOT EXISTS attendance_eligibility (event_id text NOT NULL, user_id text NOT NULL, registration_id text,
      attended_activities integer NOT NULL, total_activities integer NOT NULL, attendance_percentage numeric(5,2) NOT NULL,
      last_event_at timestamptz NOT NULL, PRIMARY KEY (event_id, user_id));
    CREATE INDEX IF NOT EXISTS attendance_eligibility_event_idx ON attendance_eligibility (event_id);

Existing activities become `OPEN`.

Rules the producers must know:
- `EventCreated` must carry `organizer_id`, otherwise nobody can see that event's reports.
- `message_id` must be unique per message and stable on resend: it is the idempotency key.
- Every message carries the full identifiers (`event_id`, `activity_id`), because the service never queries others.
- Unknown types are ignored; invalid messages are sent to the DLQ as a reference and skipped (they never block a partition).

## Known gaps
Not done yet (design decisions pending):
- `processed_messages` grows without retention.

How duplicates and reordering are handled: `processed_messages` (unique `message_id`, written in the same transaction as the effect)
cuts duplicates; each row keeps the latest state and ignores messages older than `last_event_at`. Totals are computed from that
state at query time, never kept as counters, so replays cannot corrupt them.

## Env
`PORT` (8080), `DATABASE_URL` (`postgres://reports:reports@reports-db:5432/reports`, dev default), `KAFKA_BROKERS` (`kafka:9092`),
`REPORTS_CONSUMER_GROUP`, `REPORTS_TOPIC_PARTITIONS` (6), the three topic names above, `REPORTS_DLQ_TOPIC` (`reports.dlq`). The `discovery` lib reads `SERVICE_DISCOVERER_URL`
(`http://service-discoverer:8080`) and `SERVICE_HOST` (`<hostname>:<PORT>`) itself. `REPORTS_DB_PASSWORD` (compose) sets the DB password; the root `docker-compose.yml` builds the `reports` service's `DATABASE_URL` from it, so changing it needs no other edit.

The kafkajs consumer uses `metadataMaxAge` 10 s (a topic created later is noticed quickly). If kafkajs gives up on the consumer (its `CRASH` event without
its own restart), the service disconnects it and starts a new one after a 5 s delay (start failures back off up to 30 s) instead of staying dead
while `/healthcheck` is green.

## Tests
    npm test      # node:test, no dependencies (contract parsing, metrics, routes with a fake pool, DLQ handling)
    TEST_DATABASE_URL=postgres://user:pass@localhost:5432/reports_test npm run test:integration

The integration test (`test/integration/`) needs a real, throwaway PostgreSQL: it drops and recreates the reports tables, checks that the
migration converts old-format rows and adds the lifecycle columns/eligibility table (idempotent), then projects a realistic message sequence and asserts every report, plus the lifecycle rank/stub rules, eligibility and the check-in counting rule. Without
`TEST_DATABASE_URL` it is skipped, and `npm test` never runs it.
