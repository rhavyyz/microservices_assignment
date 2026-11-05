# Platform guide: design principles and established services

Read this before building or changing a service. It describes how the pieces already in the repo fit together and the
conventions every service follows. Established services covered here: **gateway**, **service-discoverer**, **users**,
**subscription**, **notifications**. Other services (events, payments, reports, certificates) are described by their own
README/contracts; see [Integration map](#integration-map) for how they connect.

Sources of truth, in order: the code, the service's own README/`CONTRACTS.md`, the ADRs in `docs/decisions/`, and
`docs/integration/contracts-with-team.md`. If this guide disagrees with the code, the code wins; fix the guide.

---

## 1. Design principles

1. **Everything is locked behind the gateway.** The gateway is the only way in for anyone outside the network. Services
   publish no host ports. There are no shared secrets between the gateway and services: protection is network isolation
   plus the identity the gateway injects. Do not add `X-Gateway-Token`/`X-Service-Token`-style secrets (rejected in ADR-003).
2. **The gateway authenticates, services authorize.** The gateway verifies the JWT and sets `X-User-Id` and
   `X-User-Roles` (stripping any the client sent). A service reads identity **only from those headers** and decides what
   that user may do with *its* resource (ownership, organizer-of-this-activity, etc.). Do not re-validate the JWT in
   every service and do not call Users to "map a token to a user". The Users service is the exception: it issues the
   tokens and validates its own.
3. **Authenticate once per request, never mid-trip.** A user-scoped flow must not fail halfway because a token expired.
   When a service calls another on behalf of a user it forwards `X-User-Id`, `X-User-Roles`, `X-Request-Id` (and the
   `Authorization` header unchanged where the callee needs it). Background work (Kafka reactions, reconciliation jobs)
   carries no user identity.
4. **Database per service.** Each service owns its store and never reads another's. Cross-service data goes through
   HTTP APIs or Kafka events, referencing ids, not copies of sensitive data.
5. **Discover, never hardcode.** Services find each other through the service-discoverer by *kind*, using the shared
   libs (`service-discoverer/Libs/{python,go,java}`). No hostnames of other services in code or config.
6. **Boot without your dependencies.** A service starts and serves `/healthcheck` even if Kafka, the discoverer, or
   another service is down. Kafka, registration and bucket/topic provisioning run in background threads with backoff.
   Only the service's own database may block readiness.
7. **Kafka topics are created by whoever uses them, at startup** (ADR-005): create-if-absent, replication 1, configurable
   partitions (default 6), never alter an existing topic, retry in the background before consuming or producing.
   Consumers set a short `topic.metadata.refresh.interval.ms` (10 s) so a topic created later is noticed fast.
8. **At-least-once delivery, idempotent handling.** Commit offsets after processing. Dedupe by `event_id` (inbox) or a
   natural unique key. Producers use a transactional outbox when a DB write and a message must go together. Poison
   messages go to a DLQ topic as references only (topic/partition/offset/reason), never payload copies. Transient
   failures retry without advancing the offset.
9. **Natural keys over client-supplied idempotency keys.** E.g. sign-up is idempotent by (user, activity): 201 when new,
   200 when the live registration already exists.
10. **Safe by default.** Gateway routes are private (404) until an admin opens them; private and nonexistent look the
    same. Return 404, not 403, for another user's resource to avoid enumeration. Never log personal data or payloads;
    log ids. Never put secrets in committed files.
11. **Errors are `application/problem+json`** with at least `status`, `title`, `code`, `traceId` (where the service
    follows the Python/Java pattern). `X-Request-Id` is accepted (8–64 chars of `[A-Za-z0-9._-]`), generated otherwise,
    and always echoed.
12. **Small, boring, documented.** Match the surrounding code's style and comment density. Record decisions that took
    a debate as ADRs (`docs/decisions/ADR-00N-*.md`, Portuguese), keep each service's README current, and update
    `docs/integration/contracts-with-team.md` when a contract with another service changes.

## 2. Checklist for a service

- [ ] Folder `<service>/` with `Dockerfile` and `docker-compose.yml` holding only its shared infra (own DB, etc.), with
      names prefixed `<service>-`; the app instance is declared in the **root** `docker-compose.yml`, which `include`s
      the folder compose. Own network `<service>-net` plus the shared `backbone`. No host ports, no `container_name`.
- [ ] `GET /healthcheck` returns 2xx when healthy (503 if its own DB is down). The discoverer polls it.
- [ ] `GET /openapi.json` with `paths`: the gateway reads it at startup to learn the routes. Document every route,
      including error responses. Keep `/healthcheck` and `/openapi.json` private on the gateway.
- [ ] Register with the discoverer in the background (`register(kind)` blocks up to ~2.5 min) **and re-register
      periodically (~30 s)**: the registry is in memory, so a discoverer restart forgets everyone.
- [ ] Read identity from `X-User-Id`/`X-User-Roles` (401 `UNAUTHENTICATED` when absent or not a UUID).
- [ ] Register the public routes on the gateway with a script (`PUT /admin/endpoints`): `isPublic`, `requireAuth`,
      `rateLimitBy`, `maxPerMin`. See `user/scripts/register-gateway-routes.sh` and `subscription/scripts/register_gateway.py`.
      Internal-only routes (e.g. `/internal/...`) are **never** opened.
- [ ] Env-driven config with safe defaults; secrets via `${VAR:-}` empty defaults in compose (so a missing one fails
      loudly), placeholders in `.env.example`, real values in git-ignored `.env`.
- [ ] Kafka: ensure topics at startup, own consumer group, outbox/inbox as needed, DLQ with references only.
- [ ] Tests that run without Docker where possible; unit fakes for Kafka/HTTP. Integration tests may use Testcontainers.
- [ ] Docs: service README, ADR for non-obvious decisions, contract doc rows.

### Running and testing the stack

- Start the gateway's Mongo first (standalone project, creates the external `gateway-net` network):
  `docker compose -f gateway/docker-compose.yml up -d`, then `docker compose up -d --build` at the root.
- Users needs `user/.keys` (`user/scripts/gen-dev-keys.sh`) and `USERS_DB_PASSWORD`; `.env` and `user/.keys` are git-ignored.
- The gateway exposes a service's routes only after the service's registration script ran (inside the stack network; the
  admin API has no auth and no host port).
- Services not yet built need a test double registered with the discoverer under a name that resolves on the network
  (use `--network-alias`).
- **Always clean Docker after testing** (project `down -v`, your own images/containers/build cache; never a blanket
  `docker system prune -a`): the disk has filled up before. Docker lives on `/` (about 46 GB).
- Use a git worktree per task; do not commit `.env`, keys or build artifacts.

---

## 3. Integration map

```
 client ──HTTPS──> GATEWAY :8080 ── /{kind}/... ──> service (found via DISCOVERER)
                      │  verifies JWT, sets X-User-Id / X-User-Roles            ▲ register(kind), consult(kind)
                      │  /ws  <── push topic (Kafka) <── NOTIFICATIONS          │
 USERS ── issues JWT (RS256), serves JWKS ──> gateway fetches keys through the discoverer
 SUBSCRIPTION ──HTTP──> EVENTS (activity data, permissions)        ──Kafka──> PAYMENTS (commands) / <── (results)
 SUBSCRIPTION ──Kafka subscription.events──> CERTIFICATES, REPORTS ; <── EVENTS events.events (ActivityEnded/Cancelled)
 any service ──Kafka notifications topic──> NOTIFICATIONS ──> notifications-push ──> GATEWAY ──> /ws
```

Kafka topics in use (all created by their users at startup): `payments.commands`, `payments.events`, `events.events`,
`subscription.events`, `subscription.dlq`, `notifications`, `notifications-push`. Details: contracts doc section 4b.

---

## 4. Gateway (`gateway/`, Go)

**Role.** The UI-facing entry point on host port `8080` (the only host port; it cannot be scaled by replicas). A call to
`/{kind}/{downstream path}` is forwarded to a healthy instance of `kind` (via the discoverer) with the `/{kind}` prefix
stripped. Requests that do not match a known endpoint get 404.

**Pipeline** (outermost first; CORS wraps all): Logging, Resolve, Auth, RateLimit, DefaultHeaders, Proxy.

**Endpoint table** (MongoDB `gateway-db`, private, a standalone compose project). At startup, in the background, the
gateway reads each kind's `GET /openapi.json`, adds new endpoints with defaults and removes stale ones (existing
settings are never overwritten). Per-endpoint settings, changed only via the admin API:

| Setting | Default | Meaning |
|---|---|---|
| `isPublic` | `false` | `false` = indistinguishable 404 (no hint the route exists, no budget used, no downstream call). |
| `requireAuth` | `false` | `true` = the gateway demands a valid JWT: 401 (`WWW-Authenticate: Bearer`) if missing/invalid, 503 if signing keys are unavailable. With `false`, a missing/invalid token continues **anonymous**. |
| `maxPerMin` | `DEFAULT_MAX_PER_MIN` (60) | Fixed 1-minute window per gateway instance; 429 + `Retry-After`; `0` blocks. |
| `rateLimitBy` | `user_or_ip` | `user_or_ip` (verified `X-User-Id`, else IP), `ip` (use for login), `global`. |

**Identity.** The gateway fetches the JWKS of the Users service (through the discoverer), verifies RS256, `iss`, `exp`,
`kid` (cooldown of 30 s between refetches, refresh every 10 min). For **every** route it first deletes the client's
`X-User-Id`/`X-User-Roles`; with a valid token it sets `X-User-Id` = `sub` and `X-User-Roles` = `roles`
(comma-separated). `Authorization` is forwarded unchanged. Known gap: the first JWKS fetch can fail at cold start and
the cooldown then yields 503s for up to 30 s.

**Other behavior.** CORS is fully permissive for now (the gateway answers preflights, services must not set CORS
headers). Client IP is the connection address unless inside `TRUSTED_PROXIES`. `X-Request-Id` is generated if absent
and echoed.

**Admin API (no auth, no host port):** `GET /admin/endpoints[?kind=]`, `PUT /admin/endpoints` (partial update; `kind`,
`method`, `path` identify the endpoint). `GET /healthcheck`.

**`GET /ws`** (WebSocket, registered outside the endpoint table). Auth: JWT via `Authorization: Bearer` or `?access_token=`
(header wins), checked before the upgrade (401/503). Frames: `{"type":"connected"}`, then
`{"type":"notification","notification":{...}}`. One connection per user per instance, newest wins (close code 4000);
slow consumers are closed (4001); ping every 30 s.

**Push consumer.** Reads `NOTIFICATIONS_PUSH_TOPIC` as a broadcast (no consumer group, starts at the end of the topic),
forwards to the connected user's socket, best-effort.

**Env:** `PORT`, `MONGO_URI`, `SERVICE_DISCOVERER_URL`, `DEFAULT_MAX_PER_MIN`, `TRUSTED_PROXIES`, `KAFKA_BROKERS`,
`NOTIFICATIONS_PUSH_TOPIC`, `NOTIFICATIONS_PUSH_PARTITIONS` (6). Full detail: root `README.md` (Gateway), ADR-003.

## 5. Service-discoverer (`service-discoverer/`, Go + client libs)

**Role.** An in-memory registry of service instances by **kind**: `certificates`, `events`, `subscription`, `payments`,
`user`, `notifications`, `reports` (gateway and discoverer are not kinds).

**API.** `POST /register` with `{"kind","host"}` (204; 400 for an unknown kind). `GET /consult?kind=` returns
`{"host":"host:port"}` of a healthy instance (503 when none, 400 for an unknown kind). `GET /healthcheck`.

**Health.** `consult` probes every host of the kind in parallel against `GET /healthcheck` and returns the first healthy
one. A host failing 5 retries leaves rotation and is rechecked every `RECHECK_INTERVAL` (5 s); it returns on its first
success (or by re-registering) and is dropped after `RECHECK_MAX_FAILURES` (12) failed rechecks (about 1 minute).

**Client libs** (`Libs/python` stdlib only, `Libs/go`, `Libs/java`): `register(kind)` (retries 10 times, 1 s doubling to
30 s, blocks: call from a thread), `request(method, kind, path, {headers, body})` (caches the host per kind;
rediscovers and retries once if the cached host is unreachable; HTTP error statuses are returned, not raised), `consult(kind)`
(no cache). Env: `SERVICE_DISCOVERER_URL`, `SERVICE_HOST` (default `<hostname>:<PORT or 8080>`), `PORT`.
Because the registry is in memory, **re-register periodically**. Docker builds receive the Python lib through a named
`discovery` build context (`additional_contexts` in the root compose). See `service-discoverer/Libs/README.md`.

## 6. Users (`user/`, Java 21, Spring Boot, PostgreSQL)

**Role.** Accounts, authentication and the JWT issuer. Path via gateway: `/user/api/v1/...`. Reference:
`docs/architecture/users-service.md`, `docs/api/users.openapi.yaml`, ADR-001/002.

**Auth.** `POST /api/v1/auth/register` and `/login` return an RS256 access token (issuer `eventhub-users`, TTL 1800 s by
default, `kid` in the header, claims `sub` = user UUID, `roles`). `GET /.well-known/jwks.json` serves the public keys
(the gateway fetches it through the discoverer; not exposed through the gateway). **There are no refresh tokens**: the
client logs in again. Keys come from `user/.keys` (dev: `user/scripts/gen-dev-keys.sh`).

**Roles.** `PARTICIPANT` and `ORGANIZER`. `ORGANIZER` alone does not grant access to every event: Events checks
ownership per resource.

**Endpoints.**
| Route | Access |
|---|---|
| `POST /api/v1/auth/register`, `POST /api/v1/auth/login` | public (gateway: 10/min per IP) |
| `GET`/`PATCH /api/v1/users/me` | authenticated; the user comes from the JWT `sub` |
| `GET /api/v1/users?id=&email=&name=&page=&size=` | `ORGANIZER` only (role re-checked in the DB); at least one filter; returns id, name, email, roles, status |
| `GET /healthcheck`, `GET /openapi.json` | internal |
| `GET /internal/users/{id}` | **internal, unauthenticated**, returns only `{id, name}`; never opened on the gateway. Added on branch `fix/certificates-service` (not merged at the time of writing) for Certificates, which has no user token in its Kafka path. |

**Notes.** Users validates its **own** JWT (it ignores `X-User-Id`). It re-registers with the discoverer periodically. It
does not configure CORS. Audit records never contain the filtered personal data.

## 7. Subscription (`subscription/`, Python, FastAPI, PostgreSQL, Kafka)

**Role.** Sign-ups to activities: inventory, waitlist, payment hold, check-in. Path via gateway: `/subscription/...`.
Reference: `subscription/README.md`, `subscription/CONTRACTS.md`, ADR-003 and ADR-005.

**Identity.** Trusts the gateway headers only (no JWT validation): 401 `UNAUTHENTICATED` without a valid `X-User-Id`;
organizer actions need role `ORGANIZER` **and** an Events permission check on the activity.

**API** (internal paths):
| Route | Access |
|---|---|
| `POST /api/v1/activities/{id}/registrations` | participant; body `{"join_waitlist": true}`; **201 new, 200 if a live registration exists** (natural key user + activity) |
| `GET /api/v1/activities/{id}/availability` | authenticated, informational |
| `GET /api/v1/registrations/me` | own registrations (`limit` 1–100, `offset`) |
| `GET /api/v1/registrations/{id}` | owner; includes `payment.status` |
| `POST /api/v1/registrations/{id}/cancel` | owner |
| `POST /api/v1/registrations/{id}/accept-offer` | owner |
| `GET /api/v1/activities/{id}/registrations` | responsible organizer |
| `POST /api/v1/registrations/{id}/check-in` | responsible organizer; confirmed registration, inside the activity window |

**Domain rules.**
- States: `WAITLISTED`, `OFFERED`, `PENDING_PAYMENT`, `CONFIRMED`, `CANCELLED`, `EXPIRED`, `REJECTED`. `OFFERED` and
  `PENDING_PAYMENT` hold a seat; `WAITLISTED` does not.
- Every write that touches seats first locks `activity_inventory` (`FOR UPDATE`); constraints enforce
  `reserved + confirmed <= capacity` and one live registration per user/activity. Capacity is copied from Events and immutable.
- Free activities confirm immediately; paid ones hold a seat (`RESERVATION_SECONDS`, 900) and request a charge
  asynchronously. Price and currency are snapshotted at sign-up.
- Waitlist: strict FIFO by a database sequence; a freed seat is offered to the head of the queue for `OFFER_SECONDS`
  (600); the participant accepts through `accept-offer` (a paid offer then goes to payment); an expired offer passes to
  the next person. The same lock prevents a new sign-up from jumping the queue.
- Cancelling frees the seat immediately; refunds are asynchronous. A payment arriving after expiry or cancellation does
  not confirm: a refund is requested. A reconciliation job (every 60 s) re-checks pending payments.
- Attendance rule (RN06) is per event: attended activities over the event's confirmed activities. After the last
  confirmed activity of the event ends, it emits `AttendanceEligible` once per user and event, only when the percentage
  is >= 75%. It does not issue certificates.

**Messaging.** Consumes `payments.events` and `events.events` (group `subscription-service`); produces `payments.commands`,
`subscription.events` (`Registration*`, `WaitlistOffered`, `AttendanceRecorded`, `AttendanceEligible`), `notifications`,
and `subscription.dlq`. Transactional outbox, inbox dedupe by `event_id`, `aggregate_version` to reject stale states.
Envelope: `event_id`, `schema_version=1`, `type`, `registration_id`, `activity_id`, `user_id`, `aggregate_version`,
`occurred_at`, `status`; `AttendanceEligible` adds `parent_event_id`, `attended_activities`, `total_activities`,
`attendance_percentage`.

**Config highlights:** `SUBSCRIPTION_DATABASE_URL`, `KAFKA_BROKERS`, `SERVICE_DISCOVERER_URL`, `RESERVATION_SECONDS`,
`OFFER_SECONDS`, `SUBSCRIPTION_TOPIC_PARTITIONS`. Migrations run at startup.

**Known gaps:** no waitlist position view, no organizer-initiated cancel, no retention cleanup; a rare race can return
201 instead of 200 for two simultaneous first sign-ups; the OpenAPI spec does not document the 200 case. The Events and
Payments integrations were only exercised against test doubles (see below).

## 8. Notifications (`notifications/`, Go, MongoDB, Kafka)

**Role.** Persists user notifications from Kafka, serves them over HTTP and pushes them live to the gateway's `/ws`.
Kind `notifications`; path via gateway `/notifications/...`. Reference: root `README.md` (Notifications).

**Input.** Topic `notifications` (group `notifications-service`, 6 partitions by default), record **key = `user_id`**,
value `{"user_id","message","redirect_url"?,"payload"?,"payload_type"?}` (`payload` is an object and must be sent together
with `payload_type`; never send `id`/`status`). Invalid messages are logged and skipped (no DLQ). Offsets commit only after
the insert; Mongo failures retry forever.

**Storage.** Own MongoDB (`notifications-db`); `_id` = UUIDv5 of `topic/partition/offset` (idempotent redelivery);
`status` is `DEFAULT`, `RECEIVED` or `SEEN`; 30-day retention via a TTL index (`RETENTION_DAYS`).

**API.**
- `GET /list` (`X-User-Id` required): newest first, cursor pagination by `base_notification_id`, filters `status`
  (repeatable or comma-separated), `limit` 1–100 (default 20); response
  `{"notifications":[...],"next_base_notification_id":...}`. Read-only.
- `PUT /update-state` (`X-User-Id` required): `[{"id","status"}]` (1–100 items), partial application, returns
  `{"updated":n,"errors":{id:reason}}`; other users' or expired ids report `notification not found`.
- `GET /healthcheck` (200 only when Mongo answers), `GET /openapi.json`.
- Routes are private until opened on the gateway (`requireAuth: true`).

**Push.** After storing, publishes the notification to `notifications-push` (key `user_id`); the gateway forwards it to the
user's websocket. Best-effort, can duplicate (dedupe by `id`), never delays the consumer.

**To notify a user from your service:** publish the JSON above to `notifications` keyed by `user_id`, and make sure the
topic exists (ADR-005 pattern).

---

## 9. Known cross-service gaps (verify before relying on them)

- **Subscription ↔ Events contract mismatch (from reading the code, not run).** Subscription's client calls Events at
  `/api/v1/activities/{id}` (expecting `activity_id`, `amount_minor`, `currency`, `registration_open`,
  `waitlist_enabled`, `starts_at`, `ends_at`) and `/api/v1/activities/{id}/permissions/me`. Events serves
  `GET /activities/:id` (fields `id`, `price_cents`, `paid`, `title`, ...) and no `permissions/me` route that I found.
  Until reconciled, Subscription cannot talk to the real Events service.
- **Payments** was only tested with a double on Subscription's side.
- **Gateway cold-start 503** after a failed first JWKS fetch (30 s cooldown).
- **Kafka replication factor is fixed at 1** in every topic-creation helper.
- **No refresh tokens**; tokens last 30 minutes.
- Open question: Events validates the JWT itself (it ignores `X-User-Id`), unlike the model in principle 2. Align it
  when touching Events.

## 10. Working in parallel

- One worktree/branch per task, based on current `main`; keep changes inside your service plus its docs and the root
  compose/`.env.example` entries. Avoid editing another service's code unless the task is that change; if a contract
  needs one (as with `GET /internal/users/{id}`), isolate it in its own commit and document it in the contracts doc.
- Update `docs/integration/contracts-with-team.md` (rows and open questions) and the ADRs as you go; resolve merge
  conflicts in the compose and `.env.example` by keeping both sides' entries.
- Verify before reporting done: run the service's tests and, when the change crosses a boundary, an end-to-end check in the
  compose stack; then clean Docker.
