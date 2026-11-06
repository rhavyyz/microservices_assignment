"""Logging do servidor: formato dos logs da aplicação e a linha de acesso padrão da plataforma."""

import logging
import os
import sys
import time
from uuid import UUID

access_log = logging.getLogger("app.access")


def configure_logging():
    """Só para o servidor real (nunca durante os testes). LOG_LEVEL é opcional e o padrão é INFO."""
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=level if level in logging.getLevelNamesMapping() else "INFO",
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )


def access_user(raw):
    """O gateway injeta X-User-Id depois de validar o JWT; só um UUID válido é registrado (em forma canônica)."""
    try:
        return str(UUID(raw))
    except (TypeError, ValueError, AttributeError):
        return "-"


def log_access(request, status, started):
    """`<METHOD> <path> status=<N> duration=<d> user=<id|-> trace_id=<id>`; sem query, corpo nem outros cabeçalhos."""
    access_log.info(
        "%s %s status=%d duration=%dms user=%s trace_id=%s",
        request.method,
        request.url.path.encode("ascii", "backslashreplace").decode(),
        status,
        (time.perf_counter() - started) * 1000,
        access_user(request.headers.get("X-User-Id")),
        request.state.trace_id,
    )
