# Reports service

Read-only indicators for organizers (RF11): registrations, payments, occupancy and attendance per event and per activity.
It never reads another service's database: it builds its own read model (PostgreSQL `reports-db`) from Kafka events.

- Kind `reports`, registered in the service-discoverer with the shared TypeScript lib (`discovery`, `service-discoverer/Libs/typescript`, linked as a `file:` dependency).
- `GET /healthcheck`: 200 only when Postgres answers a ping, else 503. Kafka being down does **not** fail it (RQ03).
- `GET /openapi.json`: generated from the routes; the gateway reads it at startup.
- Boots even if Postgres, Kafka or the discoverer are down; migration, consumer and registration retry in the background.

## Endpoints (through the gateway: `/reports/...`)
All need `X-User-Id`. The caller must be the `organizer_id` of the event (taken from the `Event*` messages);
anything else is a 404, same as an unknown event (RN07).

| Endpoint | Returns |
|---|---|
| `GET /events` | Events owned by the caller |
| `GET /events/{eventId}/summary` | Event + registrations + payments + occupancy + attendance |
| `GET /events/{eventId}/activities` | Per-activity indicators |
| `GET /events/{eventId}/registrations` | Counts by status (`pending`, `confirmed`, `waitlisted`, `cancelled`, `expired`, `total`) |
| `GET /events/{eventId}/payments` | Counts by status + `revenue` (confirmed only) |
| `GET /events/{eventId}/attendance` | `confirmed`, `checkins`, `rate` |

Definitions: **occupied** = `PENDING` + `CONFIRMED` registrations (a pending reservation holds a seat, RN02);
**occupancy rate** = occupied / sum of activity capacities; **attendance rate** = check-ins / confirmed registrations.
Rates are `null` when the denominator is 0.

Rollout: the gateway adds new endpoints as private. Publish them once:

    for p in /events /events/{eventId}/summary /events/{eventId}/activities /events/{eventId}/registrations /events/{eventId}/payments /events/{eventId}/attendance; do
      curl -X PUT localhost:8080/admin/endpoints -d "{\"kind\":\"reports\",\"method\":\"GET\",\"path\":\"$p\",\"isPublic\":true,\"requireAuth\":true}"
    done

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
| `RegistrationPendingPayment` (stored as `PENDING`), `RegistrationConfirmed`, `RegistrationWaitlisted`, `RegistrationCancelled`, `RegistrationExpired` | subscription | `registration_id`, `event_id`, `activity_id` | `user_id` |
| `AttendanceRecorded` (check-in) | subscription | `registration_id`, `event_id`, `activity_id` | `user_id` |
| `PaymentCreated` (`PENDING`), `PaymentApproved` (`CONFIRMED`), `PaymentDeclined` (`REFUSED`), `PaymentExpired`, `PaymentCancelled` | payments | `payment_id`, `event_id` | `registration_id`, `activity_id`, `amount_minor`, `currency` |

Money: payments send `amount_minor`, an integer in minor units (cents). Reports converts it exactly to the major unit
(`2500` -> `25.00`, stored in `numeric(12,2)`); a negative, fractional, string or unsafe-integer value invalidates the message.

Known gap: Subscription's registration and check-in messages do **not** carry `event_id` (only `AttendanceEligible` does), and Reports
requires it, so those messages are currently rejected as invalid (`event_id is required (Subscription registration messages do not carry it yet)`).
See "Known gaps" below.

Everything else is ignored like any unknown type: `WaitlistOffered`, `RegistrationRejected`, `AttendanceEligible`, `PaymentRefunded`,
`ActivityDeleted`, `ActivityEnded`, `ActivityCancelled`.

Rules the producers must know:
- `EventCreated` must carry `organizer_id`, otherwise nobody can see that event's reports.
- `message_id` must be unique per message and stable on resend: it is the idempotency key.
- Every message carries the full identifiers (`event_id`, `activity_id`), because the service never queries others.
- Unknown types are ignored; invalid messages are logged and skipped (they never block a partition).

## Known gaps
Not done yet (design decisions pending):
- `event_id` on registrations and check-ins (see above); until then registration and check-in data does not reach the read model.
- New statuses: `OFFERED`, `PENDING_PAYMENT` (today `RegistrationPendingPayment` is stored as `PENDING`), `REJECTED`, `REFUNDED`.
- Money as integer cents per currency (today converted to a decimal and summed across currencies).
- `ActivityDeleted`, `ActivityEnded`, `ActivityCancelled` handling; `AttendanceEligible`.
- Monorepo conventions: problem+json errors, UUID identity, trace id rule, `x-gateway`, DLQ.

How duplicates and reordering are handled: `processed_messages` (unique `message_id`, written in the same transaction as the effect)
cuts duplicates; each row keeps the latest state and ignores messages older than `last_event_at`. Totals are computed from that
state at query time, never kept as counters, so replays cannot corrupt them.

## Env
`PORT` (8080), `DATABASE_URL` (`postgres://reports:reports@reports-db:5432/reports`, dev default), `KAFKA_BROKERS` (`kafka:9092`),
`REPORTS_CONSUMER_GROUP`, `REPORTS_TOPIC_PARTITIONS` (6), the three topic names above. The `discovery` lib reads `SERVICE_DISCOVERER_URL`
(`http://service-discoverer:8080`) and `SERVICE_HOST` (`<hostname>:<PORT>`) itself. `REPORTS_DB_PASSWORD` (compose) sets the DB password; if you change it, also set `DATABASE_URL` on the `reports` service.

## Tests
    npm test      # node:test, no dependencies (contract parsing, metrics)
