# Integrating with the service-discoverer

Every instance registers itself at startup. To call another service, ask the discoverer for a healthy instance of its **kind** instead of hardcoding a host. The libs in this folder do both and cache the host per kind for a short TTL (10s by default), so the discoverer is consulted on the first call, once the TTL expires, or when the cached instance is unreachable. See [Host cache](#host-cache).

**Kinds:** `certificates`, `events`, `subscription`, `payments`, `user`, `notifications`, `reports` (gateway and service-discoverer are not kinds).

## Requirements for a service
- Be on the `backbone` network (all services in the root compose are).
- Expose `GET /healthcheck` returning 2xx. The discoverer calls it on every consult; a host failing 5 retries is taken out of rotation, rechecked every `RECHECK_INTERVAL` and brought back on its first success (or when it re-registers). It is dropped only after `RECHECK_MAX_FAILURES` consecutive failed rechecks.
- Serve `GET /openapi.json` (OpenAPI with `paths`): the gateway reads it at startup to learn the service's endpoints.

## Config (env vars, all optional)
| Var | Default | Meaning |
|---|---|---|
| `SERVICE_DISCOVERER_URL` | `http://service-discoverer:8080` | Where the discoverer is |
| `SERVICE_HOST` | `<container hostname>:<PORT>` | Host other services use to reach this instance |
| `PORT` | `8080` | Port used when building the default `SERVICE_HOST` |
| `DISCOVERY_CACHE_TTL_SECONDS` | `10` | Seconds a discovered host is reused before the discoverer is consulted again. Decimals accepted; `0` disables caching (consult before every request). Unset, empty, non-numeric, negative, NaN or infinite values fall back to `10`. Read on each use, like `SERVICE_DISCOVERER_URL` |

Discoverer env (all optional): `RECHECK_INTERVAL` (`5s`), `RECHECK_MAX_FAILURES` (`12`, so ~1 minute of grace by default).

## Usage
Both functions: `register(kind)` once at startup with the service's own kind (it retries up to 10 times with exponential backoff, 1s doubling up to a 30s cap, about 2.5 minutes in all, then returns/raises an error; it blocks while retrying, so a service that must not wait should call it from a goroutine/thread; in TypeScript it is async, so do not `await` it before listening), and `request(method, kind, url, {headers, body})` to call another service. `url` is a path like `/charge`; `body` is sent as JSON. `consult(kind)` is also exposed on its own: it asks the discoverer for a host every time, with no caching. HTTP error statuses (4xx/5xx) are returned, not raised. Only an unreachable host triggers one rediscovery and retry.

### Host cache
The discoverer's `/consult` rotates through the healthy instances (round robin), so the libs re-consult regularly to spread load. A host is cached per kind for `DISCOVERY_CACHE_TTL_SECONDS` (default 10), measured from when it was consulted with a monotonic clock; after that the next `request` consults the discoverer again and moves to the next instance. Concurrent callers share a single in-flight consult. If the cached host is unreachable, the lib rediscovers and retries once, and that consult also restarts the TTL; if that consult fails the error is raised (the known-dead host is not used again). If refreshing an expired entry fails (discoverer unreachable) but a host was cached earlier, the lib keeps using that stale host for the call and swallows the error silently, trying again on the next call; with nothing cached the error is raised. Registration is not affected.

### Python (`service-discoverer/Libs/python`, stdlib only; `pip install ./service-discoverer/Libs/python`)
```python
from discovery import Kind, register, request

register(Kind.USER)
res = request("POST", Kind.PAYMENTS, "/charge", {"headers": {"X-Id": "1"}, "body": {"amount": 10}})
print(res.status, res.json())
```

### Go (`service-discoverer/Libs/go`, module `microservices/discovery`)
```go
import "microservices/discovery"

discovery.Register(discovery.User)
resp, err := discovery.Request("POST", discovery.Payments, "/charge",
    discovery.Options{Headers: map[string]string{"X-Id": "1"}, Body: map[string]any{"amount": 10}})
// caller closes resp.Body
```

### Java (`service-discoverer/Libs/java`, Java 17+, no dependencies)
```java
import com.microservices.discovery.*;

Discovery.register(Kind.USER);
HttpResponse<String> res = Discovery.request("POST", Kind.PAYMENTS, "/charge",
    RequestOptions.of(Map.of("X-Id", "1"), Map.of("amount", 10)));
```

### TypeScript (`service-discoverer/Libs/typescript`, Node 22+, no dependencies)
```ts
import { Kind, register, request } from "discovery";

// Fire and forget: do not await it before listening, or startup waits for the discoverer.
register(Kind.USER).catch((e) => console.error(e));
const res = await request("POST", Kind.PAYMENTS, "/charge", { headers: { "X-Id": "1" }, body: { amount: 10 } });
console.log(res.status, await res.json());
```
`request` resolves to the platform `fetch` `Response` (`status`, `headers`, `text()`, `json()`). `createClient({ fetchFn, sleep, env, ttlSeconds, now })` builds an isolated client (own host cache), which is what the tests use. `ttlSeconds` overrides `DISCOVERY_CACHE_TTL_SECONDS` (an invalid value falls back to the env var, then 10) and `now` is an injectable monotonic clock in milliseconds (default `performance.now`), so tests can use a fake clock. The package ships its `.ts` sources (an `exports` map points at `src/index.ts`), so there is no build step for the lib itself.

### Using the Go lib in a service's Docker build
A service's build context (e.g. `./notifications`) cannot see `service-discoverer/Libs/go`, so pass the lib as a named additional context and mirror the repo layout in the image (`/src` is the service folder, so `../service-discoverer/Libs/go` resolves the same on the host and in the image):
```yaml
# docker-compose.yml
build:
  context: ./my-service
  additional_contexts:
    discovery: ./service-discoverer/Libs/go
```
```dockerfile
# Dockerfile: after WORKDIR /src, before go mod download
COPY --from=discovery . /service-discoverer/Libs/go
```
```
# go.mod
require microservices/discovery v0.0.0
replace microservices/discovery => ../service-discoverer/Libs/go
```
### Using the TypeScript lib in a service's Docker build
Same `additional_contexts` pattern. With `WORKDIR /app`, `../service-discoverer/Libs/typescript` is `/service-discoverer/Libs/typescript`, on the host and in the image:
```yaml
# docker-compose.yml
build:
  context: ./my-service
  additional_contexts:
    discovery: ./service-discoverer/Libs/typescript
```
```dockerfile
# Dockerfile: in the build stage after WORKDIR /app and before npm ci,
# and again in the runtime stage (node_modules/discovery is a symlink to it)
COPY --from=discovery . /service-discoverer/Libs/typescript
```
```jsonc
// package.json
"dependencies": { "discovery": "file:../service-discoverer/Libs/typescript" }
```
The service's `tsc` build type-checks the lib sources but does not emit them (they live outside `rootDir`), so `dist/` imports `discovery` at runtime and Node loads the `.ts` files through the symlink. That needs Node 22.18+ (type stripping on by default; `node:22-alpine` qualifies) or `--experimental-strip-types` on older 22.x. Verified with the Reports `tsconfig.json` (NodeNext, `rewriteRelativeImportExtensions`) under `tsc` + `node dist/main.js` and under `node --experimental-strip-types src/main.ts`.

Python can use the same `additional_contexts` with a `COPY --from=discovery` and `pip install`; Java with a `COPY --from=discovery` and a Maven install of the lib.

## Raw protocol (any other language)
- `POST /register` with `{"kind": "payments", "host": "payments-1:8080"}` -> `204`
- `GET /consult?kind=payments` -> `200 {"host": "payments-1:8080"}`, `503` if no healthy instance, `400` for an unknown kind

## Tests
```
cd service-discoverer/Libs/python && python3 -m pytest
cd service-discoverer/Libs/go && go test ./...
cd service-discoverer/Libs/typescript && npm install && npm test && npm run typecheck
cd service-discoverer/Libs/java && javac -d /tmp/out $(find src -name '*.java') && \
  SERVICE_DISCOVERER_URL=http://127.0.0.1:18099 SERVICE_HOST=payments-1:9000 java -cp /tmp/out com.microservices.discovery.DiscoveryTest
```
