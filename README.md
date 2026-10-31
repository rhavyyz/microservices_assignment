# Monorepo

Docker Compose monorepo of services: service-discoverer, gateway, certificates, events, subscription, payments, user, notifications, reports.

- Each service folder has a `Dockerfile` and a `docker-compose.yml` (its shared infra).
- The root `docker-compose.yml` includes them all and runs one instance per service.
- `service-discoverer/Libs/` has the discovery client for Python, Go and Java; see `service-discoverer/Libs/README.md`.

- Kafka (KRaft, single broker) is the shared event bus, reachable from any service at `kafka:9092` on the `backbone` network.

## Gateway
UI-facing entry point on host port `8080` (so it cannot be scaled). Call `/{kind}/{downstream url}` (e.g. `/payments/charge?x=1`); the gateway forwards to a healthy instance of `kind` (via the service-discoverer) with the `/{kind}` prefix stripped. Requests not matching an endpoint of the service's `GET /openapi.json` get 404.
- Pipeline, outermost first: Logging, Resolve, Auth, RateLimit, DefaultHeaders, Proxy (CORS wraps everything). Each endpoint has four settings stored in Mongo (editable via the admin PUT):
  - `maxPerMin` (default `DEFAULT_MAX_PER_MIN`): fixed one-minute window per gateway instance, 429 + `Retry-After` when exceeded; `0` blocks the endpoint.
  - `rateLimitBy` (default `user_or_ip`): how the counter is keyed. `user_or_ip` = `X-User-Id` if present, else client IP; `ip` = always client IP (use for login-style endpoints so a rotating or missing user header cannot dodge the limit); `global` = one shared counter per endpoint.
  - `requireAuth` (default `false`): when `true`, a missing/empty `X-User-Id` gets 401, before rate limiting (so it consumes no budget). This is only a header-presence check for now: `X-User-Id` is trusted as-is and identity is not verified.
  - `isPublic` (default `false`, secure by default): when `false`, callers get the same 404 as for a nonexistent endpoint (no hint that the route exists, no rate-limit budget consumed, no downstream call). A freshly synced endpoint is therefore unreachable until an admin PUTs `{"isPublic": true}`. Private endpoints still take part in matching: with a private `GET /users/me` and a public `GET /users/{id}`, `/users/me` is 404 (it does not fall through to `/users/{id}`). The admin API still lists and edits private endpoints.
  - Documents stored before these fields existed read as the defaults; no migration needed. Note that this means existing endpoints in an already-populated DB become private after the `isPublic` change, until flipped with the admin PUT.
- Client IP is the connection address. Only if it is inside `TRUSTED_PROXIES` (comma-separated IPs/CIDRs, default empty) is `X-Forwarded-For` read, from the right, taking the first address that is not itself a trusted proxy; otherwise the header is ignored so it cannot be forged. Invalid entries make the gateway refuse to start. `DefaultHeaders` still forwards incoming `X-Forwarded-*` as-is.
- Endpoints live in MongoDB (`gateway-db`), which is private to the gateway: a standalone compose project (`gateway/docker-compose.yml`, not included by the root), no host ports, reachable only over the `gateway-net` network. The root project declares `gateway-net` as `external`, so the DB project must be started first. If Mongo is down or late, the gateway still boots and serves `/healthcheck`; requests that need Mongo fail fast with 5xx (3s server selection timeout) and it recovers by itself once Mongo is back (cache refresh every 30s, sync retried with backoff). At startup, in the background, the gateway reads each kind's `/openapi.json`, adds new endpoints with the defaults above (existing `maxPerMin`, `rateLimitBy`, `requireAuth` and `isPublic` are never overwritten) and removes stored endpoints no longer in the spec (only for kinds whose spec was fetched successfully; failed kinds are retried with backoff).
- Admin API (no auth yet): `GET /admin/endpoints[?kind=]`, `PUT /admin/endpoints` (partial update: `kind`, `method`, `path` identify the endpoint, plus at least one of `maxPerMin`, `rateLimitBy`, `requireAuth`, `isPublic`; only those change; 400 on invalid input, 404 if unregistered; returns the full doc), e.g.

      curl -X PUT localhost:8080/admin/endpoints -d '{"kind":"payments","method":"POST","path":"/login","rateLimitBy":"ip","maxPerMin":5,"requireAuth":false}'
      curl -X PUT localhost:8080/admin/endpoints -d '{"kind":"payments","method":"GET","path":"/users/{id}","isPublic":true}'

  `GET /healthcheck`.
- CORS is fully permissive for now (any origin is reflected, credentials allowed, preflights answered by the gateway itself).
- Env: `PORT` (8080), `MONGO_URI` (`mongodb://gateway-db:27017`), `SERVICE_DISCOVERER_URL` (`http://service-discoverer:8080`), `DEFAULT_MAX_PER_MIN` (60), `TRUSTED_PROXIES` (empty).

## Notifications
Consumes user notifications from Kafka and always stores them in its own MongoDB (`notifications-db`, part of the included compose, no host ports). Registers as kind `notifications`; serves `GET /healthcheck` (200 only when Mongo answers a ping, else 503), `GET /openapi.json` (`/healthcheck`, `/list` and `/update-state`), `GET /list` and `PUT /update-state` (below).
- Topic `NOTIFICATIONS_TOPIC` (default `notifications`), consumer group `notifications-service`. The topic is created at startup if missing (`NOTIFICATIONS_PARTITIONS` partitions, default 6, replication 1). Message value (JSON):

      {"user_id": "…", "message": "…", "redirect_url": "…", "payload": {…}, "payload_type": "…"}

  - `user_id`, `message`: required, non-empty after trimming.
  - `redirect_url`: optional opaque string (not validated); empty/blank = absent.
  - `payload` (JSON object; arrays/scalars are rejected, `null` = absent) and `payload_type` (string; empty/blank = absent): both present or both absent.
  - Producers must not send `id`, `status` or `seen`: they are never read, and any unknown field is ignored.
  - Producers should key the record by `user_id`: order is only guaranteed within a partition, so this keeps one user's notifications ordered.
- Partitions: at startup each topic is created with its configured number of partitions; if it already exists with fewer, the partitions are increased automatically (logged as `topic X: increased partitions from 1 to 6`); a topic that already has more or the same is left alone (Kafka cannot reduce partitions, so this is never an error). Replicas starting together are safe.
- Push topic `NOTIFICATIONS_PUSH_TOPIC` (default `notifications-push`, `NOTIFICATIONS_PUSH_PARTITIONS` partitions, default 6, ensured the same way): after a notification is stored the service publishes it there, meant to be consumed by the gateway (not built yet). Key = `user_id` (a user's pushes stay ordered within a partition), value (JSON, the stored notification):

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

- Startup: the HTTP server boots immediately even if Mongo, Kafka or the discoverer are down; schema setup, topic creation (the push topic in the background) and registration retry with backoff in the background.
- Env: `PORT` (8080), `KAFKA_BROKERS` (`kafka:9092`, comma-separated), `NOTIFICATIONS_TOPIC` (`notifications`), `NOTIFICATIONS_PARTITIONS` (6), `NOTIFICATIONS_PUSH_TOPIC` (`notifications-push`), `NOTIFICATIONS_PUSH_PARTITIONS` (6), `MONGO_URI` (`mongodb://notifications-db:27017`), `SERVICE_DISCOVERER_URL` (`http://service-discoverer:8080`), `SERVICE_HOST` (`<hostname>:<PORT>`), `RETENTION_DAYS` (30). The three integers (`RETENTION_DAYS` and the two partition counts) must be positive; an invalid value stops the service at startup.

## Run
Two steps, in this order (the gateway's private MongoDB is its own compose project and creates the `gateway-net` network):

    docker compose -f gateway/docker-compose.yml up -d
    docker compose up --build

Stop in reverse: `docker compose down`, then `docker compose -f gateway/docker-compose.yml down` (add `-v` to wipe the gateway DB).

## Scale
Raise `deploy.replicas` for the service in the root `docker-compose.yml` (every app service sets it explicitly, default `1`), or add another entry for the service (see the `payments-2` example).
