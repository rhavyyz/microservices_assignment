"""Logging do servidor: formato dos logs da aplicação e a linha de acesso padrão da plataforma."""

import copy
import logging
import os
import sys
import time
from uuid import UUID

from discovery import self_host

access_log = logging.getLogger("app.access")


class InstanceFilter(logging.Filter):
    """Sets record.instance to this instance's discoverer host (SERVICE_HOST, else <hostname>:<PORT>)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.instance = self_host()

    def filter(self, record):
        record.instance = self.instance
        return True


LOG_FORMAT = "%(asctime)s %(levelname)s instance=%(instance)s %(name)s %(message)s"


def configure_logging():
    """Só para o servidor real (nunca durante os testes). LOG_LEVEL é opcional e o padrão é INFO."""
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    handler.addFilter(InstanceFilter())
    logging.basicConfig(
        level=level if level in logging.getLevelNamesMapping() else "INFO",
        handlers=[handler],
    )


def uvicorn_log_config():
    """A cópia da configuração padrão do uvicorn com `instance=` nas linhas do próprio uvicorn."""
    from uvicorn.config import LOGGING_CONFIG

    config = copy.deepcopy(LOGGING_CONFIG)
    config["filters"] = {"instance": {"()": InstanceFilter}}
    for name, handler in config["handlers"].items():
        handler["filters"] = ["instance"]
    config["formatters"]["default"]["fmt"] = "%(levelprefix)s instance=%(instance)s %(message)s"
    config["formatters"]["access"]["fmt"] = (
        '%(levelprefix)s instance=%(instance)s %(client_addr)s - "%(request_line)s" %(status_code)s'
    )
    return config


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
