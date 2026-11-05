# Payments service

Handles the payment of paid activities (RF07) through a **simulated external provider**, and decides when a reservation
is paid, declined or lapsed (RN02, RN03). It owns its PostgreSQL database (`payments-db`) and talks to the rest through
REST (create / query) and Kafka (events).

- Kind `payments`, registered in the service-discoverer with the raw protocol.
- `GET /healthcheck`: 200 only when Postgres answers a ping, else 503. Kafka being down does **not** fail it (RQ03).
- `GET /openapi.json`: generated from the routes; the gateway reads it at startup.
- Boots even if Postgres, Kafka or the discoverer are down. Events are written to an **outbox** table in the same
  transaction as the state change and sent to Kafka afterwards, so a state change never loses its event (RQ04).

## State machine
```
PENDING  -> APPROVED | DECLINED | EXPIRED | CANCELLED
APPROVED -> REFUNDED                                          (only a refund can follow an approval)
DECLINED, EXPIRED, CANCELLED, REFUNDED                        (final)
```
- A final payment never changes. Repeating the same request is harmless (no-op).
- `REFUNDED` is automatic, never simulated: it happens when Subscription publishes `RegistrationCancelled` /
  `RegistrationExpired` for a registration whose payment is `APPROVED`. A refund never applies to PENDING, DECLINED, EXPIRED or CANCELLED.
- An approval that arrives after `expires_at` is **not honored**: the payment becomes `EXPIRED` and a `PaymentExpired`
  event goes out (RN03), so a late approval cannot produce a confirmed registration.
- Every change is stored in `payment_transitions` (from, to, reason, trace id).
- Payments is **reactive**: it creates payments itself (asking Subscription for the facts over HTTP) and reacts to
  Subscription's domain events. There is no command topic; Subscription neither sends commands nor calls Payments.
- Payments has its **own expiry**: a new payment lives `PAYMENT_TTL_SECONDS` (default 900), independent of the reservation.

## Trace id and errors
- `X-Trace-Id`: an incoming value is kept only if it is 8-64 chars of `[A-Za-z0-9._-]`, otherwise a UUID is generated.
  It is always echoed in the `X-Trace-Id` response header, used in logs and written as `trace_id` in the Kafka events and `payment_transitions`.
- Every error is `application/problem+json`: `{"title","status","code","detail","traceId"}` (`traceId` = the trace id).
  Codes: `UNAUTHENTICATED` (401), `VALIDATION_ERROR` (400), `PAYMENT_NOT_FOUND` / `REGISTRATION_NOT_FOUND` / `NOT_FOUND` (404),
  `REGISTRATION_NOT_PAYABLE` (409, registration not `PENDING_PAYMENT`), `PAYMENT_NOT_APPLIED` (409, simulate; adds `payment_status`),
  `UPSTREAM_UNAVAILABLE` (503, Subscription unreachable / 5xx / invalid answer; no internals in the body),
  `INTERNAL_ERROR` (500, no `detail`, nothing internal is leaked).

## Database migrations
`migrate()` runs on boot and is idempotent. It converts older databases in place: `amount` -> `amount_minor`,
statuses `CONFIRMED`/`REFUSED` -> `APPROVED`/`DECLINED` (rows, history, `simulated_*` reasons and the status CHECK),
and drops the old `payments.activity_id` column. v7 adds `REFUNDED` to the status CHECK and makes `payments.event_id` nullable.
v8 renames `processed_messages.event_id` back to `message_id` if (and only if) a database already ran the short-lived revision that had renamed it (there is no v4; that revision was removed).
v9 renames `payment_transitions.request_id` to `trace_id` if (and only if) the old column exists and the new one does not. The `X-Request-Id` header is no longer read or echoed: only `X-Trace-Id` is (hard cut, no fallback).
All are no-ops on a fresh database and on re-runs. (Not yet run against a real Postgres.)

## What this service receives

### REST
| Endpoint | Who calls it | Gateway | What it does |
|---|---|---|---|
| `POST /payments` | Front (participant) | must be opened by an admin script (out of scope here), `requireAuth` | Starts the payment of a registration |
| `GET /payments/{paymentId}` | Front | public + `requireAuth` | Payment status |
| `GET /payments?registration_id=...` | Front / subscription | public + `requireAuth` | Payment of a registration |
| `POST /payments/{paymentId}/simulate` | Front (demo / tests) | public + `requireAuth` | Simulated provider: `{"action":"approve"\|"decline"\|"expire"}` |

Through the gateway the URLs are `/payments/payments/...` (first `payments` is the kind, which the gateway strips).
The read and simulate endpoints need `X-User-Id`, which must be a UUID (missing or not a UUID = 401 `UNAUTHENTICATED`), and only answer for the payment's owner (`user_id`); anything else is a 404 (RN07).
`simulate` answers 409 `PAYMENT_NOT_APPLIED` when the request could not be honored (already final, or deadline passed); the real payment status comes in `payment_status`.
Set `SIMULATOR_ENABLED=false` to turn the simulator off.

**`POST /payments` body** (participant-facing):

    {"registration_id":"<uuid>"}

- Only `registration_id` is read (missing / not a UUID = 400 `VALIDATION_ERROR`); unknown properties are ignored. Amount, currency, owner and event never come from the client.
- Flow: Payments calls Subscription `GET /internal/registrations/{id}` (that endpoint belongs to Subscription, not Payments) with the caller's `X-Trace-Id`, and uses the answer:
  - Subscription 404, or the registration belongs to another user -> 404 `REGISTRATION_NOT_FOUND` (other users' registrations are never revealed);
  - status other than `PENDING_PAYMENT` -> 409 `REGISTRATION_NOT_PAYABLE`;
  - registration `expires_at` not in the future (checked against Payments' clock, after the owner and status checks; Subscription's expiry worker can lag a few seconds) -> 409 `REGISTRATION_NOT_PAYABLE`;
  - Subscription unreachable, 5xx or invalid body -> 503 `UPSTREAM_UNAVAILABLE`;
  - otherwise the payment is created `PENDING` with `amount_minor`, `currency`, `user_id` and `event_id` (nullable) from Subscription's answer.
- `expires_at = now + PAYMENT_TTL_SECONDS` (Payments' own deadline).
- Idempotent by `registration_id`: if a payment already exists it is returned unchanged (200 instead of 201) after the owner check, without asking Subscription again.
- Answer: `{payment_id, registration_id, user_id, event_id, amount_minor, currency, status:"PENDING", expires_at, created_at}`.
- The route must be opened on the gateway by an admin script later (out of scope here).

Subscription lookup (`src/subscription.ts`): `GET {SERVICE_DISCOVERER_URL}/consult?kind=subscription` -> `{"host":"host:port"}`, then `GET http://<host>/internal/registrations/{id}`.
The host is cached; on a connection failure the discoverer is consulted again and the call retried once. Timeout 5 s per call.

### Kafka (consumed)
Topic `subscription.events` (env `SUBSCRIPTION_TOPIC`), group `PAYMENTS_CONSUMER_GROUP` (`payments-service`), read from the beginning, metadata refresh 10 s.
Required fields of the flat envelope: `message_id`, `schema_version` (integer; > 1 is rejected), `type`, `registration_id`; extra fields and unknown types are tolerated.
- `RegistrationCancelled` / `RegistrationExpired`: payment `PENDING` -> `CANCELLED`, `APPROVED` -> `REFUNDED` (reason `registration_cancelled` / `registration_expired`); any other state, or no payment, is a no-op.
- Every other type (including `RegistrationPendingPayment`) is ignored.
- Deduped by `message_id` in `processed_messages`, committed in the same transaction as the effect (at-least-once). A database error throws, so the offset is not committed. Invalid messages are logged (ids only, never payloads) and skipped.

At startup Payments creates (if absent, 1 replica, `PAYMENTS_TOPIC_PARTITIONS` partitions) `payments.events`, `notifications` and `subscription.events`. There is no `payments.commands` topic.

**One payment per registration:** Payments holds at most one payment per `registration_id` (deduped by `registration_id`).

## What this service sends

### Kafka: topic `payments.events` (key = `registration_id`, env `PAYMENT_EVENTS_TOPIC`)
Flat envelope, no nested `data`:

    {"message_id","schema_version":1,"type","occurred_at","trace_id","registration_id","amount_minor","currency",
     "payment_id","user_id","event_id","status","reason"}

- `message_id` is the unique id of the message (consumers dedupe by it). The Events-service event the payment belongs to
  is published as `event_id` (same name in the HTTP API and the `payments.event_id` column).
- `amount_minor` is an integer in minor units (2500 = 25.00).
- `type` by status: `PENDING` -> `PaymentCreated`, `APPROVED` -> `PaymentApproved`, `DECLINED` -> `PaymentDeclined`,
  `EXPIRED` -> `PaymentExpired`, `CANCELLED` -> `PaymentCancelled`, `REFUNDED` -> `PaymentRefunded`.
  Subscription reads only `message_id`, `schema_version`, `type`, `registration_id`, `amount_minor`, `currency`, `trace_id`.

`reason` says why (null on `PaymentCreated`): `simulated_approval`, `simulated_decline`, `simulated_expiration`,
`payment_deadline` (expired by the job), `expired_before_confirmation` (late approval), `registration_cancelled`,
`registration_expired`.

Who is expected to act on them:
- **Subscription**: `PaymentApproved` confirms the registration; `PaymentDeclined` and `PaymentExpired` release the seat (RN02, RN03).
- **Reports**: counts payments and revenue (already consumes this contract).
- `activity_id` is no longer published (Reports will be updated separately).
- Delivery is at-least-once, so consumers must dedupe by `message_id`.

### Kafka: topic `notifications` (key = `user_id`)
On `APPROVED`, `DECLINED` and `EXPIRED` the user gets a notification (format of the Notifications service:
`user_id`, `message`, `payload` + `payload_type: "payment"`); the text shows a human amount computed from `amount_minor` (e.g. `BRL 25.00`). On `REFUNDED` too (a short Portuguese notice that the payment was refunded). `PENDING` and `CANCELLED` are not notified.
A crash between sending and marking the outbox row can in theory send the same notification twice.

## Expiry
A background job (every `EXPIRY_INTERVAL_MS`, default 5s) expires `PENDING` payments whose `expires_at` passed
(`SKIP LOCKED`, safe with several replicas). The reservation's seat is released by the subscription service when it
receives `PaymentExpired`.

## Gateway rollout
`POST /payments` is participant-facing now and must also be opened (public + `requireAuth`) by an admin script later; that is out of scope here.
The three routes below are the ones the existing script publishes:

    $routes = @(@('GET','/payments'),@('GET','/payments/{paymentId}'),@('POST','/payments/{paymentId}/simulate'))
    foreach ($r in $routes) {
      $body = @{ kind='payments'; method=$r[0]; path=$r[1]; isPublic=$true; requireAuth=$true } | ConvertTo-Json -Compress
      Invoke-RestMethod -Method Put -Uri http://localhost:8080/admin/endpoints -Body $body -ContentType 'application/json'
    }

## Env
`PORT` (8080), `DATABASE_URL` (`postgres://payments:change-me@payments-db:5432/payments`, dev default), `KAFKA_BROKERS` (`kafka:9092`),
`PAYMENT_EVENTS_TOPIC` (`payments.events`), `SUBSCRIPTION_TOPIC` (`subscription.events`, consumed), `NOTIFICATIONS_TOPIC` (`notifications`), `PAYMENTS_CONSUMER_GROUP` (`payments-service`), `PAYMENT_TTL_SECONDS` (900, positive integer), `PAYMENTS_TOPIC_PARTITIONS` (6),
`EXPIRY_INTERVAL_MS` (5000), `OUTBOX_INTERVAL_MS` (500), `SIMULATOR_ENABLED` (true), `SERVICE_DISCOVERER_URL`, `SERVICE_HOST`.
`PAYMENTS_DB_PASSWORD` (compose) sets the DB password; if you change it, also set `DATABASE_URL` on the `payments` service.

## Tests
    npm test      # node:test, no dependencies (state machine, event/notification builders, input validation, discovery, config defaults, HTTP errors/trace id via `inject` with a fake pool)
