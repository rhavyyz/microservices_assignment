# Monorepo

Execução completa, dados de demonstração e testes: [`docs/running.md`](docs/running.md). Evidências de validação: `docs/evidence/`.

Docker Compose monorepo of services: service-discoverer, gateway, certificates, events, subscription, payments, user, notifications, reports, plus the React frontend in `frontend/` (run with Vite, not in the Compose stack). Architecture decisions: the three ADRs in `docs/decisions/` and the implementation notes (DT-nn) in `docs/architecture/technical-decisions.md`.

- Each service folder has a `Dockerfile` and a `docker-compose.yml` (its shared infra).
- The root `docker-compose.yml` includes them all and runs one instance per service.
- `service-discoverer/Libs/` has the discovery client for Python, Go, Java and TypeScript; see `service-discoverer/Libs/README.md`.

- Kafka (KRaft, single broker) is the shared event bus, reachable from any service at `kafka:9092` on the `backbone` network.

## Gateway
UI-facing entry point on host port `8080` (so it cannot be scaled). Call `/{kind}/{downstream url}` (e.g. `/payments/charge?x=1`); the gateway forwards to a healthy instance of `kind` (via the service-discoverer) with the `/{kind}` prefix stripped. Requests not matching an endpoint of the service's `GET /openapi.json` get 404.
- Pipeline, outermost first: Logging, Resolve, Auth, RateLimit, DefaultHeaders, Proxy (CORS wraps everything). Each endpoint has four settings stored in Mongo (editable via the admin PUT):
  - `maxPerMin` (default `DEFAULT_MAX_PER_MIN`): fixed one-minute window per gateway instance, 429 + `Retry-After` when exceeded; `0` blocks the endpoint.
  - `rateLimitBy` (default `user_or_ip`): how the counter is keyed. `user_or_ip` = `X-User-Id` if present, else client IP; `ip` = always client IP (use for login-style endpoints so a rotating or missing user header cannot dodge the limit); `global` = one shared counter per endpoint.
  - `requireAuth` (default `false`): when `true`, a missing/empty `X-User-Id` gets 401, before rate limiting (so it consumes no budget). This is only a header-presence check for now: `X-User-Id` is trusted as-is and identity is not verified.
  - `isPublic` (default `false`, secure by default): when `false`, callers get the same 404 as for a nonexistent endpoint (no hint that the route exists, no rate-limit budget consumed, no downstream call). A freshly synced endpoint is therefore unreachable until an admin PUTs `{"isPublic": true}`, unless the service declared `isPublic: true` for it in its OpenAPI (see `x-gateway` below). Private endpoints still take part in matching: with a private `GET /users/me` and a public `GET /users/{id}`, `/users/me` is 404 (it does not fall through to `/users/{id}`). The admin API still lists and edits private endpoints.
  - Documents stored before these fields existed read as the defaults; no migration needed. Note that this means existing endpoints in an already-populated DB become private after the `isPublic` change, until flipped with the admin PUT.
- Client IP is the connection address. Only if it is inside `TRUSTED_PROXIES` (comma-separated IPs/CIDRs, default empty) is `X-Forwarded-For` read, from the right, taking the first address that is not itself a trusted proxy; otherwise the header is ignored so it cannot be forged. Invalid entries make the gateway refuse to start. `DefaultHeaders` still forwards incoming `X-Forwarded-*` as-is.
- `X-Trace-Id`: the outermost middleware (`TraceID`) validates the client's value with the same rule as the services (`^[A-Za-z0-9._-]{8,64}$`), replaces an invalid or missing one with a generated id (never reflected raw), sets it on every response, including the gateway's own errors, `/ws`, `/admin`, `/healthcheck`, `/openapi.json` and `/docs`, and forwards the validated one upstream (and in the request log line). Across the platform, Kafka messages carry the originating request's `trace_id` in the envelope and consumers continue it when it is valid; background work uses null.
- Endpoints live in MongoDB (`gateway-db`), which is private to the gateway: a standalone compose project (`gateway/docker-compose.yml`, not included by the root), no host ports, reachable only over the `gateway-net` network. The root project declares `gateway-net` as `external`, so the DB project must be started first. If Mongo is down or late, the gateway still boots and serves `/healthcheck`; requests that need Mongo fail fast with 5xx (3s server selection timeout) and it recovers by itself once Mongo is back (cache refresh every 30s, sync retried with backoff). At startup, in the background, the gateway reads each kind's `/openapi.json`, adds new endpoints with the settings they declare in `x-gateway`, else the defaults above (existing `maxPerMin`, `rateLimitBy`, `requireAuth` and `isPublic` are never overwritten) and removes stored endpoints no longer in the spec (only for kinds whose spec was fetched successfully; failed kinds are retried with backoff).
- Settings declared by the service (`x-gateway`): each operation in the service's `GET /openapi.json` may describe the gateway settings of that endpoint with the vendor extension `x-gateway`:

      "paths": {"/api/v1/x": {"get": {"x-gateway": {"isPublic": true, "requireAuth": true, "maxPerMin": 120, "rateLimitBy": "user_or_ip"}}}}

  | key | type | default when absent or invalid |
  |---|---|---|
  | `isPublic` | boolean | `false` |
  | `requireAuth` | boolean | `false` |
  | `maxPerMin` | integer >= 0 (`0` blocks the endpoint) | `DEFAULT_MAX_PER_MIN` |
  | `rateLimitBy` | `user_or_ip`, `ip` or `global` | `user_or_ip` |

  All keys are optional; with no `x-gateway` the endpoint is created with the defaults (private). The keys are the same as the admin API's.
  - Insert-only: the declaration is read only when the sync **inserts** an endpoint that is not stored yet. An endpoint already in the DB is never changed by the spec, so admin `PUT` edits stay authoritative at runtime and a later change to the declaration does not reach an endpoint already stored. To re-apply a declaration, `PUT` the values through the admin API, or delete the endpoint document in `gateway-db` (the next sync, at gateway start, inserts it again from the declaration).
  - Validation: an invalid value (wrong type, negative `maxPerMin`, unknown `rateLimitBy`) is ignored for that key only, which takes its default, and is logged once per sync as `sync <kind>: <METHOD> <path>: x-gateway.<key> ignored: <reason>`. An `x-gateway` that is not a JSON object is ignored (logged); unknown keys inside it are ignored (one log line per endpoint). A bad declaration never fails the sync. Logged values are truncated.
  - Security: a service can now declare itself public. The risk is accepted (trusted network, services are ours, and the admin API remains the runtime control); see DT-03.
- Admin API (no auth yet): `GET /admin/endpoints[?kind=]`, `PUT /admin/endpoints` (partial update: `kind`, `method`, `path` identify the endpoint, plus at least one of `maxPerMin`, `rateLimitBy`, `requireAuth`, `isPublic`; only those change; 400 on invalid input, 404 if unregistered; returns the full doc), e.g.

      curl -X PUT localhost:8080/admin/endpoints -d '{"kind":"payments","method":"POST","path":"/login","rateLimitBy":"ip","maxPerMin":5,"requireAuth":false}'
      curl -X PUT localhost:8080/admin/endpoints -d '{"kind":"payments","method":"GET","path":"/users/{id}","isPublic":true}'

  `GET /healthcheck`.
- CORS is fully permissive for now (any origin is reflected, credentials allowed, preflights answered by the gateway itself).
- `GET /ws` (websocket, for the frontend): receives the notifications pushed for the user in real time. It is registered directly on the mux, not part of the endpoint table, so it is not subject to `isPublic`/`requireAuth`/rate limiting (a connection rate limit is not implemented yet); it is still wrapped by CORS and Logging.
  - Identity: the verified RS256 JWT (same rules as the rest of the gateway), sent as `Authorization: Bearer <jwt>` or, since browsers cannot set headers on `new WebSocket(...)`, as the `access_token` query parameter; the header wins when both are present. The user is the token's `sub`; `X-User-Id`/`X-User-Roles` sent by the client are dropped and `user_id` is no longer accepted. Everything is checked before upgrading, as plain HTTP: no token or an invalid/expired token = 401 (`WWW-Authenticate: Bearer`), signing keys unavailable = 503. The connection is verified only at upgrade time: an open connection outlives the token's `exp`. A token in a URL can end up in proxy/access logs elsewhere (the gateway logs only the path), so use TLS and short token lifetimes. Any `Origin` is accepted (same decision as the permissive CORS).
  - Frames are JSON text. Right after the upgrade: `{"type":"connected"}` (the connection is registered). For each push: `{"type":"notification","notification":{"id", "message", "redirect_url"|null, "payload"|null, "payload_type"|null, "status", "created_at"}}`, the same fields as an item of `/notifications/list` (the push message without `user_id`). Pushes can repeat (see the Notifications push topic), so dedupe by `id`. Anything the client sends is discarded.
  - One connection per user per gateway instance, newest wins: a new connection for the same user closes the old one with close code `4000` (reason `replaced by a newer connection`). With several gateway replicas the rule is enforced per replica only (no shared state yet).
  - Keepalive: the gateway pings every 30s and drops a connection that sends nothing (pongs included) for 70s; client messages are limited to 4 KiB.
- Push consumer: the gateway reads the Notifications push topic (`NOTIFICATIONS_PUSH_TOPIC`) and forwards each message, as it arrives, to the websocket of its `user_id` if that user is connected to this instance. It is a broadcast: there is no consumer group, so every gateway instance sees every message (needed once the gateway is scaled) and no groups pile up in Kafka. Consumption starts at the end of the topic when the gateway starts, so pushes produced while the gateway was down, or to a user who was offline, are not replayed: the client recovers through `/notifications/list`. Partitions added later are consumed from their beginning (noticed within 30s, the metadata refresh).
  - Best-effort and non-blocking: a push for a user with no connection here is dropped; each connection has a queue of 32 frames and a connection that cannot keep up is closed (code `4001`) instead of slowing the consumer. Invalid messages (bad JSON, no `id` or `user_id`) are logged and skipped. The consumer runs in the background: if Kafka is down or late the gateway boots and serves everything else, reconnects by itself, and repeated errors are logged at most once per 30s.
- API docs: `GET /openapi.json` is one OpenAPI 3.0.3 document merging the specs of all kinds, and `GET /docs` is a Swagger UI page (swagger-ui-dist 5.17.14 from jsdelivr) that loads it. Both are public and served by the gateway itself. Only operations that are **public in the live endpoint table** are listed (private endpoints are never listed; an admin `PUT` shows up without a restart), under `/{kind}/<service path>`, with `bearerAuth` on the ones that `requireAuth`, and the effective settings in `x-gateway`. Components are renamed `<Kind>_<name>`. The specs are fetched at startup (retried with backoff) and refreshed every `DOCS_REFRESH_EVERY` (Go duration, default `5m`, invalid value = refuses to start); a failed refresh keeps the previous copy, and the description names the kinds whose spec is unavailable.
- Env: `PORT` (8080), `MONGO_URI` (`mongodb://gateway-db:27017`), `SERVICE_DISCOVERER_URL` (`http://service-discoverer:8080`), `DEFAULT_MAX_PER_MIN` (60), `DOCS_REFRESH_EVERY` (5m), `DISCOVERY_CACHE_TTL_SECONDS` (10; seconds, decimals accepted, `0` = consult before every request; the gateway uses the discovery lib's host cache, which reads this variable and reuses a consulted host for that long so the discoverer's round robin spreads load; the gateway validates it at startup and refuses to start on an invalid value), `TRUSTED_PROXIES` (empty), `KAFKA_BROKERS` (`kafka:9092`, comma-separated), `NOTIFICATIONS_PUSH_TOPIC` (`notifications-push`), `NOTIFICATIONS_PUSH_PARTITIONS` (6). At startup the gateway creates the push topic if it does not exist (never changes an existing one); keep the partition count equal to Notifications'.

## Notifications
Consumes user notifications from Kafka and always stores them in its own MongoDB (`notifications-db`, part of the included compose, no host ports). Registers as kind `notifications` through the Go discovery lib; serves `GET /healthcheck` (200 only when Mongo answers a ping, else 503), `GET /openapi.json` (`/healthcheck`, `/list` and `/update-state`), `GET /list` and `PUT /update-state` (below).
- Topic `NOTIFICATIONS_TOPIC` (default `notifications`), consumer group `notifications-service`. The topic is created at startup if missing (`NOTIFICATIONS_PARTITIONS` partitions, default 6, replication 1). Message value (JSON):

      {"user_id": "…", "message": "…", "redirect_url": "…", "payload": {…}, "payload_type": "…"}

  - `user_id`, `message`: required, non-empty after trimming.
  - `redirect_url`: optional opaque string (not validated); empty/blank = absent.
  - `payload` (JSON object; arrays/scalars are rejected, `null` = absent) and `payload_type` (string; empty/blank = absent): both present or both absent.
  - Producers must not send `id`, `status` or `seen`: they are never read, and any unknown field is ignored.
  - Producers should key the record by `user_id`: order is only guaranteed within a partition, so this keeps one user's notifications ordered.
- Partitions: at startup each topic is created with its configured number of partitions; if it already exists with fewer, the partitions are increased automatically (logged as `topic X: increased partitions from 1 to 6`); a topic that already has more or the same is left alone (Kafka cannot reduce partitions, so this is never an error). Replicas starting together are safe.
- Push topic `NOTIFICATIONS_PUSH_TOPIC` (default `notifications-push`, `NOTIFICATIONS_PUSH_PARTITIONS` partitions, default 6, ensured the same way): after a notification is stored the service publishes it there, consumed by the gateway, which forwards it to the user's websocket (`GET /ws`). Key = `user_id` (a user's pushes stay ordered within a partition), value (JSON, the stored notification):

      {"id": "…", "user_id": "…", "message": "…", "redirect_url": "…"|null, "payload": {…}|null, "payload_type": "…"|null, "status": "DEFAULT", "created_at": "2026-01-02T03:04:05.678Z"}

  - `status` is the stored one (`DEFAULT` for a new notification); `created_at` has the same format as in `/list`.
  - Best-effort and asynchronous: the push never delays the consumption nor the offset commit, is not retried beyond a 10s delivery timeout, and failures are only logged. A missed push is recovered through `/list`. Invalid messages publish nothing.
  - It can be published more than once (after a redelivery the stored notification is published again), so receivers must dedupe by `id`.
  - The push topic is ensured in the background, so it never blocks consuming; pushes sent before it exists are lost (logged).
- Stored document (database `notifications`, collection `notifications`): `{_id, user_id, message, redirect_url|null, payload|null, payload_type|null, status, created_at}`. `created_at` is the consumption time (UTC). A `$jsonSchema` validator and the index `{user_id: 1, created_at: -1, _id: -1}` (serves the listing; the previous `{user_id: 1, created_at: -1}` one is created-over then dropped at startup, idempotent and replica-safe) and a TTL index `created_at_ttl` on `created_at` (see Retention) are ensured at startup.
- `status` is `DEFAULT`, `RECEIVED` or `SEEN`; the consumer always inserts `DEFAULT`; only `PUT /update-state` changes it afterwards.
- `_id` is always generated by the service: a UUIDv5 of `topic/partition/offset`, so a redelivered record gets the same `_id`; a duplicate-key insert counts as success (idempotent).
- Offsets are committed only after the insert succeeded (or the record was skipped); Mongo failures are retried with backoff and the record is never skipped. Invalid messages (bad JSON, failed validation) are logged with topic/partition/offset and the reason, skipped and committed past (no DLQ).
- Retention: notifications older than 30 days (`RETENTION_DAYS`) are expired by a MongoDB TTL index on `created_at`, whatever their `status`. Mongo's background monitor removes them roughly within a minute after they pass the age (not a daily batch), so no job runs in the service and replicas need no coordination. Changing `RETENTION_DAYS` updates the index (`collMod`) at the next startup; the plain `created_at` index from earlier versions is dropped and replaced.
- `GET /list` (through the gateway: `/notifications/list`): the user's notifications, newest first, cursor-paginated. Read-only: it never changes a `status`.
  - Header `X-User-Id`: required, non-empty after trimming, else 401. It is the only way the user is chosen.
  - Query `base_notification_id`: optional UUID. Absent/empty = the most recent notifications; otherwise the ones older than that notification. Not a UUID = 400.
  - Query `status`: optional, repeatable (`?status=DEFAULT&status=SEEN`) or comma-separated (`?status=DEFAULT,SEEN`); duplicates are ignored. Absent = all. Anything but `DEFAULT`, `RECEIVED`, `SEEN` (uppercase) = 400.
  - Query `limit`: optional integer, default 20, 1 to 100, else 400.
  - 200 `application/json`: `{"notifications": [{"id", "message", "redirect_url"|null, "payload"|null, "payload_type"|null, "status", "created_at"}], "next_base_notification_id": "<id of the last item>"|null}`. `notifications` is `[]` when empty, `user_id` is not included, `created_at` is RFC3339 in UTC with milliseconds (`2026-01-02T03:04:05.678Z`). `next_base_notification_id` is `null` on the last page (the service fetches `limit + 1` rows to know); pass it as `base_notification_id` to get the next page.
  - Errors: 401, 400 (above), 404 when the base notification does not exist, belongs to another user or has expired (same body for all, nothing leaks), 500 on a MongoDB error (generic body, the cause is only logged).
  - Cursor semantics: ids are UUIDv5 of `topic/partition/offset`, so they are not time-ordered. The order is `(created_at desc, _id desc)` and the cursor is the base's position in it: older = `created_at` before the base's, or the same `created_at` and a smaller `_id`. Notifications that arrive while paginating are newer, so they never shift or duplicate the pages already walked. The base's own status does not have to match the `status` filter. If the base expires (retention) between pages, the next call is a 404.
  - Rollout: the gateway adds new endpoints as private, so an admin must publish it once:

        curl -X PUT localhost:8080/admin/endpoints -d '{"kind":"notifications","method":"GET","path":"/list","isPublic":true,"requireAuth":true}'

- `PUT /update-state` (through the gateway: `/notifications/update-state`): changes the `status` of several of the user's own notifications in one call. Only `status` is written.
  - Header `X-User-Id`: required, non-empty after trimming, else 401 (same as `/list`).
  - Body (max 1 MiB): a JSON array of 1 to 100 items, `[{"id": "<uuid>", "status": "SEEN"}, ...]`. Unknown fields in an item are ignored. Bad JSON, not an array, an item of the wrong shape, an empty array or more than 100 items (`at most 100 updates per request`) = 400 with a plain-text error.
  - Partial application: the items that are valid and owned by the user are applied, the failing ones are skipped and reported; a failing item never blocks the others.
  - Response, always `application/json` for a well-formed request: `{"updated": <n>, "errors": {"<id>": "<reason>", ...}}`. `errors` is keyed by the trimmed id (a missing or empty id is keyed `""`) and is `{}` when empty. `updated` is the number of notifications the write matched, not the size of the request; setting the status a notification already has counts.
  - Reasons: `invalid id` (not a UUID), `invalid status` (missing or not exactly `DEFAULT`, `RECEIVED` or `SEEN`), `duplicate id` (the id appears more than once in the request, even with equal statuses; none of its occurrences is applied), `notification not found`. When an id has several problems only the first, in that order, is reported. Ids are matched as sent, case-sensitively: an uppercase-hex UUID is `notification not found`, it is not lowercased.
  - `notification not found` is the same for an id that does not exist, belongs to another user or has expired (nothing leaks).
  - Status code: 200 when `updated` >= 1 (even if `errors` is not empty); 400 when nothing was applied and `errors` is not empty (`updated` 0 with no errors can only happen through the TTL race below, and is a 200). 500 on a MongoDB error (generic body, the cause is only logged).
  - Any status to any status is allowed. At most 100 items per request.
  - Not transactional (standalone Mongo): the existence check and the write are separate operations, so a notification can in theory expire through the TTL index in between; its update then matches nothing, so `updated` is lower than the number of owned items and that id is not reported in `errors`.
  - Rollout: the gateway adds new endpoints as private, so an admin must publish it once:

        curl -X PUT localhost:8080/admin/endpoints -d '{"kind":"notifications","method":"PUT","path":"/update-state","isPublic":true,"requireAuth":true}'

- Startup: the HTTP server boots immediately even if Mongo, Kafka or the discoverer are down; schema setup, topic creation (the push topic in the background) and registration (the lib retries up to 10 times with exponential backoff, 1s to 30s, about 2.5 minutes) run in the background.
- Registration uses the shared Go discovery lib (`service-discoverer/Libs/go`), pulled into the image with a compose `additional_contexts` entry. To do the same in another Go service:

      # docker-compose.yml
      build:
        context: ./my-service
        additional_contexts:
          discovery: ./service-discoverer/Libs/go

      # Dockerfile (after WORKDIR /src, before go mod download; /src is my-service/)
      COPY --from=discovery . /service-discoverer/Libs/go

      # go.mod
      require microservices/discovery v0.0.0
      replace microservices/discovery => ../service-discoverer/Libs/go

  The same idea works for Python (`COPY --from=discovery` then `pip install`) and Java (`COPY --from=discovery` then a Maven install of the lib).
- Env: `PORT` (8080), `KAFKA_BROKERS` (`kafka:9092`, comma-separated), `NOTIFICATIONS_TOPIC` (`notifications`), `NOTIFICATIONS_PARTITIONS` (6), `NOTIFICATIONS_PUSH_TOPIC` (`notifications-push`), `NOTIFICATIONS_PUSH_PARTITIONS` (6), `MONGO_URI` (`mongodb://notifications-db:27017`), `SERVICE_DISCOVERER_URL` (`http://service-discoverer:8080`) and `SERVICE_HOST` (`<hostname>:<PORT>`) read by the lib, `RETENTION_DAYS` (30). The three integers (`RETENTION_DAYS` and the two partition counts) must be positive; an invalid value stops the service at startup.

## Events
Events, their schedule (activities) and seat capacity (TypeScript, Fastify, its own PostgreSQL `events-db`). Full docs in `events/README.md`; architecture decisions in `events/docs/decisions.md`.
- Public reads (search of published events, schedule with available seats); changes need the user service's access token (`Authorization: Bearer`, verified against its JWKS), and only the event's organizer can change it.
- Keeps only the capacity of each activity (the reservation and the seat counting belong to the subscription service, which asks Events for the activity with `GET /api/v1/activities/{id}`). Publishes `EventCreated|Updated|Published|Cancelled`, `ActivityCreated|Updated|Deleted|Ended|Cancelled` on `events.events` through a transactional outbox; consumes nothing.
- A fresh gateway seeds the routes from the service's OpenAPI (`x-gateway`); only a gateway that already had the `events` kind needs `events/scripts/register-gateway-routes.sh`.

## Run
Full guide (prerequisites, `.env`, demo data, failure scenarios, tests per service): [`docs/running.md`](docs/running.md). In short, in this order (the gateway's private MongoDB is its own compose project and creates the `gateway-net` network):

    cp .env.example .env                       # set USERS_DB_PASSWORD and SUBSCRIPTION_DB_PASSWORD (and the admin bootstrap, if wanted)
    user/scripts/gen-dev-keys.sh               # JWT signing key for development
    docker compose -f gateway/docker-compose.yml up -d
    docker compose --env-file .env up --build -d
    ADMIN_PASSWORD='...' scripts/demo-seed.sh  # optional: demo users, event and a paid registration

Stop in reverse: `docker compose down`, then `docker compose -f gateway/docker-compose.yml down` (add `-v` to wipe the gateway DB).

## Scale
Raise `deploy.replicas` for the service in the root `docker-compose.yml` (every app service sets it explicitly, default `1`), or add another entry for the service (see the `payments-2` example).

## User service (`user/`)
Registration, login (JWT RS256) and own-profile API (Spring Boot 4.1, Java 21, PostgreSQL). Docs: `docs/architecture/users-service.md`, `docs/api/users.openapi.yaml`, `docs/integration/contracts-with-team.md`, `docs/decisions/`.

    cp .env.example .env                       # set USERS_DB_PASSWORD (the user-db refuses to start without it)
    user/scripts/gen-dev-keys.sh               # dev JWT signing key in user/.keys (git-ignored)
    docker compose -f gateway/docker-compose.yml up -d   # gateway-db first (creates the gateway-net network)
    docker compose --env-file .env up --build            # whole stack; the Gateway is on http://localhost:8080

Every service declares its Gateway settings (`x-gateway`: public or not, `requireAuth`) in its own OpenAPI document, and the
Gateway applies them when it syncs the kind, so no manual route registration is needed for the user service. The scripts
under `*/scripts/register-*` are only for overriding limits by hand (they use the unauthenticated admin API).

Caveat: the Gateway only *seeds* endpoints it does not know yet; it never changes `isPublic`, `requireAuth` or the limits of an
existing one. With an old Gateway database (routes created before `x-gateway` existed) those routes stay private and the Gateway
answers `404` in microseconds, without reaching the service. Reset it (stop the stack first, then drop the Gateway volume):

    docker compose --env-file .env down
    docker compose -f gateway/docker-compose.yml down -v
    docker compose -f gateway/docker-compose.yml up -d && docker compose --env-file .env up -d

or fix single routes with `PUT /admin/endpoints`. Check with `curl -s localhost:8080/admin/endpoints | tr '{' '\n' | grep subscription`.

Then the API is `http://localhost:8080/user/api/v1/...` (register, login, `users/me`, `users` search for organizers, `admin/users` for administrators).

Organizers and the administrator (DT-11): the sign-up form lets a person choose *Organizer*, but that only opens a pending request;
the account stays a participant until an **administrator** approves it in the web app (`/admin/usuarios`). No HTTP route grants
`ADMIN`; create the first one from the environment, then turn it off again:

    # in .env
    USERS_ADMIN_BOOTSTRAP_ENABLED=true
    USERS_ADMIN_BOOTSTRAP_NAME=Administrador
    USERS_ADMIN_BOOTSTRAP_EMAIL=admin@example.test
    USERS_ADMIN_BOOTSTRAP_PASSWORD=<a strong password>

After an approval the person must sign out and in again (the role travels in the 30-minute token). Login and sign-up are limited to
10 requests/min per IP through `x-gateway`; on an already populated Gateway database apply it with `user/scripts/register-gateway-routes.sh`.
Warning: the Gateway admin API (`/admin/...`) has no authentication and shares that port.

Run the tests (needs JDK 21; `*IT` need Docker):

    (cd service-discoverer/Libs/java && mvn -q install -DskipTests)   # discovery lib -> local Maven repo
    cd user && ./mvnw verify

Run outside Docker: publish the database with `docker compose --env-file .env -f user/docker-compose.yml -f user/docker-compose.dev.yml up -d user-db`, then export `USERS_DB_URL=jdbc:postgresql://localhost:5433/users`, `USERS_DB_USER`, `USERS_DB_PASSWORD`, `USERS_JWT_PRIVATE_KEY_FILE=$PWD/user/.keys/jwt-private.pem`, `USERS_DISCOVERY_ENABLED=false` and run `./mvnw spring-boot:run` in `user/`.

> Status: the backend test suite is `cd user && ./mvnw verify` (needs Docker); run it after pulling, since other teams changed the service (trace id, access log, OpenAPI gateway settings). See `docs/testing/test-report.md` for the last recorded results.

## Frontend (`frontend/`)
React 19 + TypeScript + Vite: catálogo público de eventos, inscrição por atividade, minhas inscrições, cadastro, login, perfil e, para organizadores, busca de usuários e a área do organizador (criar, editar, publicar e cancelar eventos, atividades, participantes e check-in). Também: pagamento das inscrições (provedor simulado) e notificações em tempo real (WebSocket do Gateway, com consulta periódica como reserva). Fala só com o Gateway. Docs: `docs/architecture/frontend.md`, `docs/architecture/technical-decisions.md` (DT-07), (DT-08).

    cd frontend
    cp .env.example .env     # VITE_API_BASE_URL = URL do Gateway (http://localhost:8080 com o docker compose)
    npm ci
    npm run dev              # http://localhost:5173

Scripts: `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm run test:run` (297 testes), `npm run build` (saída em `frontend/dist`). Requer Node `^22.22.2`, `^24.15.0` ou `>=26` (o jsdom 30, usado nos testes, exige isso; o build sozinho aceitaria `^20.19` ou `>=22.12`).

O token de acesso fica só em memória: recarregar a página exige novo login (DT-07). As rotas dos serviços são abertas no Gateway pelo `x-gateway` de cada OpenAPI, sem scripts, mas só em um banco do Gateway novo: o Gateway não altera rotas que já existiam (veja a observação acima sobre `down -v`). O catálogo de eventos funciona sem login; inscrever-se exige login. O contrato de Eventos mudou no `main` (rotas em `/api/v1`, vagas vindas de Inscrições): o frontend segue o contrato atual, e os testes leem as rotas direto do código dos serviços para acusar qualquer divergência.
