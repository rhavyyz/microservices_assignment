# Monorepo

Docker Compose monorepo of services: service-discoverer, gateway, certificates, events, subscription, payments, user, notifications, reports.

- Each service folder has a `Dockerfile` and a `docker-compose.yml` (its shared infra).
- The root `docker-compose.yml` includes them all and runs one instance per service.
- `service-discoverer/Libs/` has the discovery client for Python, Go and Java; see `service-discoverer/Libs/README.md`.

- Kafka (KRaft, single broker) is the shared event bus, reachable from any service at `kafka:9092` on the `backbone` network.

## Gateway
UI-facing entry point on host port `8080` (so it cannot be scaled). Call `/{kind}/{downstream url}` (e.g. `/payments/charge?x=1`); the gateway forwards to a healthy instance of `kind` (via the service-discoverer) with the `/{kind}` prefix stripped. Requests not matching an endpoint of the service's `GET /openapi.json` get 404.
- Every request needs an `X-User-Id` header (trusted as-is, 401 if missing). Rate limit: `maxPerMin` per user per endpoint (fixed one-minute window, per gateway instance), 429 + `Retry-After` when exceeded; `0` blocks the endpoint.
- Endpoints live in MongoDB (`gateway-db`), which is private to the gateway: a standalone compose project (`gateway/docker-compose.yml`, not included by the root), no host ports, reachable only over the `gateway-net` network. The root project declares `gateway-net` as `external`, so the DB project must be started first. If Mongo is down or late, the gateway still boots and serves `/healthcheck`; requests that need Mongo fail fast with 5xx (3s server selection timeout) and it recovers by itself once Mongo is back (cache refresh every 30s, sync retried with backoff). At startup, in the background, the gateway reads each kind's `/openapi.json`, adds new endpoints with `DEFAULT_MAX_PER_MIN` (existing `maxPerMin` is never overwritten) and removes stored endpoints no longer in the spec (only for kinds whose spec was fetched successfully; failed kinds are retried with backoff).
- Admin API (no auth yet): `GET /admin/endpoints[?kind=]`, `PUT /admin/endpoints` with `{"kind","method","path","maxPerMin"}`. `GET /healthcheck`.
- CORS is fully permissive for now (any origin is reflected, credentials allowed, preflights answered by the gateway itself).
- Env: `PORT` (8080), `MONGO_URI` (`mongodb://gateway-db:27017`), `SERVICE_DISCOVERER_URL` (`http://service-discoverer:8080`), `DEFAULT_MAX_PER_MIN` (60).

## Run
Two steps, in this order (the gateway's private MongoDB is its own compose project and creates the `gateway-net` network):

    docker compose -f gateway/docker-compose.yml up -d
    docker compose up --build

Stop in reverse: `docker compose down`, then `docker compose -f gateway/docker-compose.yml down` (add `-v` to wipe the gateway DB).

## Scale
Raise `deploy.replicas` for the service in the root `docker-compose.yml` (every app service sets it explicitly, default `1`), or add another entry for the service (see the `payments-2` example).
