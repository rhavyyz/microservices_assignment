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

## Run
Two steps, in this order (the gateway's private MongoDB is its own compose project and creates the `gateway-net` network):

    docker compose -f gateway/docker-compose.yml up -d
    docker compose up --build

Stop in reverse: `docker compose down`, then `docker compose -f gateway/docker-compose.yml down` (add `-v` to wipe the gateway DB).

## Scale
Raise `deploy.replicas` for the service in the root `docker-compose.yml` (every app service sets it explicitly, default `1`), or add another entry for the service (see the `payments-2` example).
