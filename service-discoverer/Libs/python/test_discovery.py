import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import discovery
from discovery import client


def serve(handler):
    srv = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"127.0.0.1:{srv.server_port}"


class Target(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        out = json.dumps({"echo": json.loads(body), "x": self.headers.get("X-Test"),
                          "ct": self.headers.get("Content-Type")}).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


@pytest.fixture
def discoverer(monkeypatch):
    state = {"hosts": [], "consults": 0, "registered": None}

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            state["consults"] += 1
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"host": state["hosts"].pop(0)}).encode())

        def do_POST(self):
            state["registered"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv, host = serve(H)
    monkeypatch.setenv("SERVICE_DISCOVERER_URL", "http://" + host)
    monkeypatch.delenv("DISCOVERY_CACHE_TTL_SECONDS", raising=False)
    for c in client._caches.values():
        c.host = None
        c.expires_at = 0.0
    return state


def test_register(discoverer, monkeypatch):
    monkeypatch.setenv("SERVICE_HOST", "payments-1:9000")
    discovery.register(discovery.Kind.PAYMENTS)
    assert discoverer["registered"] == {"kind": "payments", "host": "payments-1:9000"}


@pytest.fixture
def sleeps(monkeypatch):
    delays = []
    monkeypatch.setattr(client, "_sleep", delays.append)
    return delays


def flaky_discoverer(monkeypatch, failures):
    state = {"calls": 0}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            state["calls"] += 1
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(503 if state["calls"] <= failures else 204)
            self.end_headers()

        def log_message(self, *a):
            pass

    _, host = serve(H)
    monkeypatch.setenv("SERVICE_DISCOVERER_URL", "http://" + host)
    monkeypatch.setenv("SERVICE_HOST", "payments-1:9000")
    return state


def test_register_retries_until_success(monkeypatch, sleeps):
    state = flaky_discoverer(monkeypatch, 3)
    discovery.register(discovery.Kind.PAYMENTS)
    assert state["calls"] == 4
    assert sleeps == [1, 2, 4]


def test_register_gives_up_with_backoff(monkeypatch, sleeps):
    state = flaky_discoverer(monkeypatch, 1000)
    with pytest.raises(RuntimeError, match="could not register with the service-discoverer: register failed: 503"):
        discovery.register(discovery.Kind.PAYMENTS)
    assert state["calls"] == 10
    assert sleeps == [1, 2, 4, 8, 16, 30, 30, 30, 30]


def test_register_retries_connection_errors(monkeypatch, sleeps):
    dead, host = serve(Target)
    dead.shutdown()
    dead.server_close()
    monkeypatch.setenv("SERVICE_DISCOVERER_URL", "http://" + host)
    with pytest.raises(RuntimeError, match="could not register"):
        discovery.register(discovery.Kind.PAYMENTS)
    assert len(sleeps) == 9


def test_request_caches_host(discoverer):
    _, target = serve(Target)
    discoverer["hosts"] = [target]
    for _ in range(3):
        r = discovery.request("POST", discovery.Kind.USER, "/x", {"headers": {"X-Test": "1"}, "body": {"a": 1}})
        assert r.json() == {"echo": {"a": 1}, "x": "1", "ct": "application/json"}
    assert discoverer["consults"] == 1


def test_rediscovers_when_unreachable(discoverer):
    dead, dead_host = serve(Target)
    dead.shutdown()
    dead.server_close()
    _, good = serve(Target)
    discoverer["hosts"] = [dead_host, good]
    r = discovery.request("POST", discovery.Kind.EVENTS, "/x", {"body": {"b": 2}})
    assert r.json()["echo"] == {"b": 2}
    assert discoverer["consults"] == 2
    discovery.request("POST", discovery.Kind.EVENTS, "/x", {"body": {}})
    assert discoverer["consults"] == 2


def test_consult_does_not_cache(discoverer):
    discoverer["hosts"] = ["a:1", "b:2"]
    assert discovery.consult(discovery.Kind.USER) == "a:1"
    assert discovery.consult(discovery.Kind.USER) == "b:2"
    assert discoverer["consults"] == 2


@pytest.fixture
def clock(monkeypatch):
    t = [1000.0]
    monkeypatch.setattr(client, "_now", lambda: t[0])
    return t


def call(kind):
    return discovery.request("POST", kind, "/x", {"body": {}})


def test_cache_expires_and_moves_to_next_host(discoverer, clock):
    s1, h1 = serve(Target)
    s2, h2 = serve(Target)
    discoverer["hosts"] = [h1, h2]
    call(discovery.Kind.USER)
    clock[0] += 9.9
    call(discovery.Kind.USER)
    assert discoverer["consults"] == 1
    assert client._caches[discovery.Kind.USER].host == h1
    clock[0] += 0.2
    call(discovery.Kind.USER)
    assert discoverer["consults"] == 2
    assert client._caches[discovery.Kind.USER].host == h2


def test_ttl_from_env_decimal(discoverer, clock, monkeypatch):
    monkeypatch.setenv("DISCOVERY_CACHE_TTL_SECONDS", "0.5")
    _, h = serve(Target)
    discoverer["hosts"] = [h, h]
    call(discovery.Kind.USER)
    clock[0] += 0.4
    call(discovery.Kind.USER)
    assert discoverer["consults"] == 1
    clock[0] += 0.2
    call(discovery.Kind.USER)
    assert discoverer["consults"] == 2


def test_ttl_zero_consults_every_time(discoverer, clock, monkeypatch):
    monkeypatch.setenv("DISCOVERY_CACHE_TTL_SECONDS", "0")
    _, h = serve(Target)
    discoverer["hosts"] = [h, h, h]
    for _ in range(3):
        call(discovery.Kind.USER)
    assert discoverer["consults"] == 3


@pytest.mark.parametrize("value", ["", "abc", "-1", "nan", "inf", "-inf"])
def test_invalid_ttl_falls_back_to_default(value, monkeypatch):
    monkeypatch.setenv("DISCOVERY_CACHE_TTL_SECONDS", value)
    assert client._cache_ttl() == 10.0


def test_ttl_default_and_values(monkeypatch):
    monkeypatch.delenv("DISCOVERY_CACHE_TTL_SECONDS", raising=False)
    assert client._cache_ttl() == 10.0
    monkeypatch.setenv("DISCOVERY_CACHE_TTL_SECONDS", "2.5")
    assert client._cache_ttl() == 2.5
    monkeypatch.setenv("DISCOVERY_CACHE_TTL_SECONDS", "0")
    assert client._cache_ttl() == 0.0


def test_invalid_ttl_used_in_request(discoverer, clock, monkeypatch):
    monkeypatch.setenv("DISCOVERY_CACHE_TTL_SECONDS", "junk")
    _, h = serve(Target)
    discoverer["hosts"] = [h, h]
    call(discovery.Kind.USER)
    clock[0] += 9
    call(discovery.Kind.USER)
    assert discoverer["consults"] == 1
    clock[0] += 2
    call(discovery.Kind.USER)
    assert discoverer["consults"] == 2


def test_stale_host_reused_when_refresh_fails(discoverer, clock):
    _, h = serve(Target)
    discoverer["hosts"] = [h]  # the next consult pops from an empty list: the handler fails
    call(discovery.Kind.USER)
    clock[0] += 11
    r = call(discovery.Kind.USER)  # refresh fails, old host kept
    assert r.status == 200
    assert discoverer["consults"] == 2
    discoverer["hosts"] = [h]
    clock[0] += 0.1
    call(discovery.Kind.USER)  # still expired, so it tries again
    assert discoverer["consults"] == 3


def test_expired_refresh_failure_with_nothing_cached_raises(discoverer):
    with pytest.raises(Exception):
        call(discovery.Kind.USER)


def test_rediscovery_resets_ttl_and_failure_raises(discoverer, clock):
    dead, dead_host = serve(Target)
    dead.shutdown()
    dead.server_close()
    _, good = serve(Target)
    discoverer["hosts"] = [good, "unused"]
    call(discovery.Kind.USER)
    good_srv_cache = client._caches[discovery.Kind.USER]
    good_srv_cache.host = dead_host  # cached host died
    clock[0] += 5
    discoverer["hosts"] = [good]
    call(discovery.Kind.USER)
    assert client._caches[discovery.Kind.USER].host == good
    assert client._caches[discovery.Kind.USER].expires_at == 1005.0 + 10
    # dead host and the rediscovery consult fails: raise, no fallback to the dead host
    good_srv_cache.host = dead_host
    discoverer["hosts"] = []
    with pytest.raises(Exception):
        call(discovery.Kind.USER)


def test_self_host_uses_service_host(monkeypatch):
    monkeypatch.setenv("SERVICE_HOST", "payments-1:9000")
    monkeypatch.setenv("PORT", "1234")
    assert discovery.self_host() == "payments-1:9000"


def test_self_host_defaults_to_hostname_and_8080(monkeypatch):
    monkeypatch.delenv("SERVICE_HOST", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    monkeypatch.setattr(client.socket, "gethostname", lambda: "box")
    assert discovery.self_host() == "box:8080"


def test_self_host_uses_port_and_ignores_empty_service_host(monkeypatch):
    monkeypatch.setenv("SERVICE_HOST", "")
    monkeypatch.setenv("PORT", "9100")
    monkeypatch.setattr(client.socket, "gethostname", lambda: "box")
    assert discovery.self_host() == "box:9100"
