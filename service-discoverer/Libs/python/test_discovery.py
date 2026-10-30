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
    for c in client._caches.values():
        c.host = None
    return state


def test_register(discoverer, monkeypatch):
    monkeypatch.setenv("SERVICE_HOST", "payments-1:9000")
    discovery.register(discovery.Kind.PAYMENTS)
    assert discoverer["registered"] == {"kind": "payments", "host": "payments-1:9000"}


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
