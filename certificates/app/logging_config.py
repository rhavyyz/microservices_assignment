"""Server logging: application log format and the platform-wide access line."""

import logging
import os
import sys
import time
from uuid import UUID

access_log = logging.getLogger("app.access")


def configure_logging():
    """Only for the real server (never under pytest). LOG_LEVEL is optional and defaults to INFO."""
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=level if level in logging.getLevelNamesMapping() else "INFO",
        format="%(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )


def access_user(raw):
    """The gateway injects X-User-Id after verifying the JWT; only a valid UUID is logged (canonical form)."""
    try:
        return str(UUID(raw))
    except (TypeError, ValueError, AttributeError):
        return "-"


def log_access(request, status, started):
    """`<METHOD> <path> status=<N> duration=<d> user=<id|-> trace_id=<id>`; no query string, body or other headers."""
    access_log.info(
        "%s %s status=%d duration=%dms user=%s trace_id=%s",
        request.method,
        request.url.path.encode("ascii", "backslashreplace").decode(),
        status,
        (time.perf_counter() - started) * 1000,
        access_user(request.headers.get("X-User-Id")),
        request.state.trace_id,
    )
