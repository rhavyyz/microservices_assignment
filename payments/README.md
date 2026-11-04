# Payments service

Handles the payment of paid activities (RF07) through a **simulated external provider**, and decides when a reservation
is paid, refused or lapsed (RN02, RN03). It owns its PostgreSQL database (`payments-db`) and talks to the rest through
REST (create / query) and Kafka (events).

- Kind `payments`, registered in the service-discoverer with the raw protocol.
- `GET /healthcheck`: 200 only when Postgres answers a ping, else 503. Kafka being down does **not** fail it (RQ03).
- `GET /openapi.json`: generated from the routes; the gateway reads it at startup.
- Boots even if Postgres, Kafka or the discoverer are down. Events are written to an **outbox** table in the same
  transaction as the state change and sent to Kafka afterwards, so a state change never loses its event (RQ04).

## State machine
```
PENDING -> CONFIRMED | REFUSED | EXPIRED | CANCELLED        (all four are final)
```
- A final payment never changes. Repeating the same request is harmless (no-op).
- A confirmation that arrives after `expires_at` is **not honored**: the payment becomes `EXPIRED` and a `payment.expired`
  event goes out (RN03), so a late confirmation cannot produce a confirmed registration.
- Every change is stored in `payment_transitions` (from, to, reason, correlation id).
- Refunds of an already confirmed payment are out of scope.

## What this service receives

### REST
| Endpoint | Who calls it | Gateway | What it does |
|---|---|---|---|
| `POST /payments` | **Subscription service**, through the discoverer | keep **private** | Starts a payment for a reservation |
| `GET /payments/{paymentId}` | Front | public + `requireAuth` | Payment status |
| `GET /payments?registration_id=...` | Front / subscription | public + `requireAuth` | Payment of a registration |
| `POST /payments/{paymentId}/simulate` | Front (demo / tests) | public + `requireAuth` | Simulated provider: `{"action":"confirm"\|"refuse"\|"expire"}` |

Through the gateway the URLs are `/payments/payments/...` (first `payments` is the kind, which the gateway strips).
The read and simulate endpoints need `X-User-Id` and only answer for the payment's owner (`user_id`); anything else is a 404 (RN07).
`simulate` answers 409 with the real `status` when the request could not be honored (already final, or deadline passed).
Set `SIMULATOR_ENABLED=false` to turn the simulator off.

**`POST /payments` body** (what the subscription service must send):

    {"registration_id":"...","user_id":"...","event_id":"...","activity_id":"...",
     "amount":50.00,"currency":"BRL","expires_at":"2026-10-31T12:15:00Z"}

- `currency` is optional (default `BRL`); `amount` > 0 with at most 2 decimals; `expires_at` must be in the future
  and should be the **same deadline as the reservation**, so both expire together.
- Idempotent by `registration_id`: repeating the call returns the existing payment (200 instead of 201). Same
  `registration_id` with a different user or amount = 409.
- Answer: `{payment_id, registration_id, user_id, event_id, activity_id, amount, currency, status:"PENDING", expires_at, created_at}`.

How to call it from another service (raw protocol, no lib needed beyond the shared ones):
`GET http://service-discoverer:8080/consult?kind=payments` -> `{"host":"payments-1:8080"}`, then `POST http://<host>/payments`.
(Go/Python/Java: `discovery.Request("POST", payments, "/payments", ...)`.)

### Kafka (consumed)
Topic `subscription-events`, group `payments-service`, idempotent by `message_id`:

| `type` | Required `data` | Effect |
|---|---|---|
| `registration.cancelled`, `registration.expired` | `registration_id` | Cancels the registration's payment if it is still `PENDING` (a payment already final is left alone) |

Envelope: `{"message_id","type","version":1,"occurred_at","correlation_id","data":{...}}`. Other types are ignored,
invalid messages are logged and skipped.

## What this service sends

### Kafka: topic `payments-events` (key = `registration_id`)
`payment.created`, `payment.confirmed`, `payment.refused`, `payment.expired`, `payment.cancelled`, same envelope as above, with:

    "data": {"payment_id","registration_id","user_id","event_id","activity_id","amount","currency","status","reason"}

`reason` says why (null on `payment.created`): `simulated_confirmation`, `simulated_refusal`, `simulated_expiration`,
`payment_deadline` (expired by the job), `expired_before_confirmation` (late confirmation), `registration_cancelled`,
`registration_expired`.

Who is expected to act on them:
- **Subscription**: `payment.confirmed` confirms the registration; `payment.refused` and `payment.expired` release the seat (RN02, RN03).
- **Reports**: counts payments and revenue (already consumes this contract).
- Delivery is at-least-once, so consumers must dedupe by `message_id`.

### Kafka: topic `notifications` (key = `user_id`)
On `CONFIRMED`, `REFUSED` and `EXPIRED` the user gets a notification (format of the Notifications service:
`user_id`, `message`, `payload` + `payload_type: "payment"`). `PENDING` and `CANCELLED` are not notified.
A crash between sending and marking the outbox row can in theory send the same notification twice.

## Expiry
A background job (every `EXPIRY_INTERVAL_MS`, default 5s) expires `PENDING` payments whose `expires_at` passed
(`SKIP LOCKED`, safe with several replicas). The reservation's seat is released by the subscription service when it
receives `payment.expired`.

## Gateway rollout
New endpoints are private; publish the three the front uses (leave `POST /payments` private):

    $routes = @(@('GET','/payments'),@('GET','/payments/{paymentId}'),@('POST','/payments/{paymentId}/simulate'))
    foreach ($r in $routes) {
      $body = @{ kind='payments'; method=$r[0]; path=$r[1]; isPublic=$true; requireAuth=$true } | ConvertTo-Json -Compress
      Invoke-RestMethod -Method Put -Uri http://localhost:8080/admin/endpoints -Body $body -ContentType 'application/json'
    }

## Env
`PORT` (8080), `DATABASE_URL` (`postgres://payments:change-me@payments-db:5432/payments`, dev default), `KAFKA_BROKERS` (`kafka:9092`),
`PAYMENTS_TOPIC`, `SUBSCRIPTION_TOPIC`, `NOTIFICATIONS_TOPIC`, `PAYMENTS_CONSUMER_GROUP`, `PAYMENTS_TOPIC_PARTITIONS` (6),
`EXPIRY_INTERVAL_MS` (5000), `OUTBOX_INTERVAL_MS` (500), `SIMULATOR_ENABLED` (true), `SERVICE_DISCOVERER_URL`, `SERVICE_HOST`.
`PAYMENTS_DB_PASSWORD` (compose) sets the DB password; if you change it, also set `DATABASE_URL` on the `payments` service.

## Tests
    npm test      # node:test, no dependencies (state machine, event/notification builders, input validation, discovery)
