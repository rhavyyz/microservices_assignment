import json as _json
import math
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional

from .kinds import Kind

REGISTER_ATTEMPTS = 10
REGISTER_INITIAL_DELAY = 1.0
REGISTER_MAX_DELAY = 30.0
TIMEOUT = 5.0
DEFAULT_CACHE_TTL = 10.0  # seconds

_sleep = time.sleep  # replaced in tests
_now = time.monotonic  # replaced in tests


def _discoverer_url() -> str:
    return os.environ.get("SERVICE_DISCOVERER_URL", "http://service-discoverer:8080").rstrip("/")


def _cache_ttl() -> float:
    """DISCOVERY_CACHE_TTL_SECONDS (decimals accepted, 0 = no caching); anything invalid gives 10."""
    try:
        ttl = float(os.environ.get("DISCOVERY_CACHE_TTL_SECONDS", ""))
    except ValueError:
        return DEFAULT_CACHE_TTL
    if math.isnan(ttl) or math.isinf(ttl) or ttl < 0:
        return DEFAULT_CACHE_TTL
    return ttl


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


def self_host() -> str:
    """This instance's host as registered in the discoverer: SERVICE_HOST, or "<hostname>:<PORT or 8080>"."""
    return os.environ.get("SERVICE_HOST") or f"{socket.gethostname()}:{os.environ.get('PORT', '8080')}"


def register(kind: Kind) -> None:
    """Registers this instance. Call once at startup, passing only its own kind.

    The host sent is `self_host()`: SERVICE_HOST, or "<container hostname>:<PORT or 8080>".
    Retries up to 10 times with a delay doubling from 1s up to 30s (about 2.5 minutes
    in all), so it blocks meanwhile: call it from a thread if the service must not wait.
    """
    payload = _json.dumps({"kind": Kind(kind).value, "host": self_host()}).encode()
    last: Optional[Exception] = None
    delay = REGISTER_INITIAL_DELAY
    for attempt in range(REGISTER_ATTEMPTS):
        if attempt:
            _sleep(delay)
            delay = min(delay * 2, REGISTER_MAX_DELAY)
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
        self.expires_at = 0.0  # monotonic time after which `host` must be refreshed


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
    """Returns the cached host while its TTL lasts, asking the discoverer if there is none,
    it expired or it is `stale` (known unreachable).

    If an expired host cannot be refreshed, the old one is kept for this call and the error
    is swallowed. A failed refresh of a `stale` host raises.
    """
    cache = _caches[kind]
    with cache.lock:
        if cache.host is not None:
            if stale is not None and cache.host != stale:
                return cache.host  # someone already rediscovered
            if stale is None and _now() < cache.expires_at:
                return cache.host
        started = _now()
        try:
            host = consult(kind)
        except Exception:
            if cache.host is not None and stale is None:
                return cache.host
            raise
        cache.host = host
        cache.expires_at = started + _cache_ttl()
        return host


def request(method: str, kind: Kind, url: str, options: Optional[Dict[str, Any]] = None) -> Response:
    """Calls `url` (a path like "/charge") on an instance of `kind`.

    options: {"headers": {...}, "body": <json-serializable>}, both optional.
    The host is cached per kind for DISCOVERY_CACHE_TTL_SECONDS (default 10, 0 = consult
    every time). If the cached host is unreachable, the host is rediscovered and the call retried once.
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
