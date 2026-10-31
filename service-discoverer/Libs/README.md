# Integrating with the service-discoverer

Every instance registers itself at startup. To call another service, ask the discoverer for a healthy instance of its **kind** instead of hardcoding a host. The libs in this folder do both and cache the host per kind, so the discoverer is only consulted on the first call or when the cached instance is unreachable.

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

Discoverer env (all optional): `RECHECK_INTERVAL` (`5s`), `RECHECK_MAX_FAILURES` (`12`, so ~1 minute of grace by default).

## Usage
Both functions: `register(kind)` once at startup with the service's own kind, and `request(method, kind, url, {headers, body})` to call another service. `url` is a path like `/charge`; `body` is sent as JSON. `consult(kind)` is also exposed on its own: it asks the discoverer for a host every time, with no caching (`request` uses it internally). HTTP error statuses (4xx/5xx) are returned, not raised. Only an unreachable host triggers one rediscovery and retry.

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

## Raw protocol (any other language)
- `POST /register` with `{"kind": "payments", "host": "payments-1:8080"}` -> `204`
- `GET /consult?kind=payments` -> `200 {"host": "payments-1:8080"}`, `503` if no healthy instance, `400` for an unknown kind

## Tests
```
cd service-discoverer/Libs/python && python3 -m pytest
cd service-discoverer/Libs/go && go test ./...
cd service-discoverer/Libs/java && javac -d /tmp/out $(find src -name '*.java') && \
  SERVICE_DISCOVERER_URL=http://127.0.0.1:18099 SERVICE_HOST=payments-1:9000 java -cp /tmp/out com.microservices.discovery.DiscoveryTest
```
