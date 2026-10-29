import json as _json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional

from .kinds import Kind

REGISTER_ATTEMPTS = 5
REGISTER_DELAY = 1.0
TIMEOUT = 5.0


def _discoverer_url() -> str:
    return os.environ.get("SERVICE_DISCOVERER_URL", "http://service-discoverer:8080").rstrip("/")


@dataclass
class Response:
    status: int
    headers: Dict[str, str]
    body: bytes

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        return _json.loads(self.body)


def _send(method: str, url: str, headers: Dict[str, str], body: Optional[bytes]) -> Response:
    """Plain HTTP call. HTTP error statuses are returned; only transport errors raise."""
    req = urllib.request.Request(url, data=body, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return Response(r.status, dict(r.headers), r.read())
    except urllib.error.HTTPError as e:
        return Response(e.code, dict(e.headers), e.read())


def register(kind: Kind) -> None:
    """Registers this instance. Call once at startup, passing only its own kind.

    The host sent is SERVICE_HOST, or "<container hostname>:<PORT or 8080>".
    """
    host = os.environ.get("SERVICE_HOST") or f"{socket.gethostname()}:{os.environ.get('PORT', '8080')}"
    payload = _json.dumps({"kind": Kind(kind).value, "host": host}).encode()
    last: Optional[Exception] = None
    for attempt in range(REGISTER_ATTEMPTS):
        if attempt:
            time.sleep(REGISTER_DELAY)
        try:
            res = _send("POST", _discoverer_url() + "/register", {"Content-Type": "application/json"}, payload)
            if 200 <= res.status < 300:
                return
            last = RuntimeError(f"register failed: {res.status} {res.text.strip()}")
        except OSError as e:
            last = e
    raise RuntimeError(f"could not register with the service-discoverer: {last}")


class _KindCache:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.host: Optional[str] = None


# One cache per kind for this process. The kinds are fixed, so the dict never changes.
_caches = {k: _KindCache() for k in Kind}


def consult(kind: Kind) -> str:
    """Asks the service-discoverer for a healthy host of `kind`. No caching."""
    kind = Kind(kind)
    res = _send("GET", f"{_discoverer_url()}/consult?kind={kind.value}", {}, None)
    if res.status != 200:
        raise RuntimeError(f"consult {kind.value} failed: {res.status} {res.text.strip()}")
    return res.json()["host"]


def _resolve(kind: Kind, stale: Optional[str] = None) -> str:
    """Returns the cached host, asking the discoverer if there is none or it is `stale`."""
    cache = _caches[kind]
    with cache.lock:
        if cache.host is None or cache.host == stale:
            cache.host = consult(kind)
        return cache.host


def request(method: str, kind: Kind, url: str, options: Optional[Dict[str, Any]] = None) -> Response:
    """Calls `url` (a path like "/charge") on an instance of `kind`.

    options: {"headers": {...}, "body": <json-serializable>}, both optional.
    If the cached host is unreachable, the host is rediscovered and the call retried once.
    """
    kind = Kind(kind)
    options = options or {}
    headers = dict(options.get("headers") or {})
    body = None
    if options.get("body") is not None:
        body = _json.dumps(options["body"]).encode()
        if not any(h.lower() == "content-type" for h in headers):
            headers["Content-Type"] = "application/json"
    path = url if url.startswith("/") else "/" + url

    host = _resolve(kind)
    try:
        return _send(method, f"http://{host}{path}", headers, body)
    except OSError:  # URLError, connection refused, timeouts
        host = _resolve(kind, stale=host)
        return _send(method, f"http://{host}{path}", headers, body)
