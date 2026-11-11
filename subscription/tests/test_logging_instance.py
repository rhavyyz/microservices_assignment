"""Every log line carries instance=<this instance's discoverer host>, exactly once."""

import logging
import socket
import time
from types import SimpleNamespace

import pytest

from app import logging_config


@pytest.fixture
def handler(monkeypatch):
    """The handler configure_logging would install on the root logger (basicConfig is captured)."""
    monkeypatch.setenv("SERVICE_HOST", "svc-a:9001")
    captured = {}
    monkeypatch.setattr(logging, "basicConfig", lambda **kw: captured.update(kw))
    logging_config.configure_logging()
    (h,) = captured["handlers"]
    return h


def render(h, logger, msg, *args):
    record = logging.LogRecord(logger, logging.WARNING, __file__, 1, msg, args, None)
    assert h.filter(record)
    return h.format(record)


def test_any_logger_line_has_the_instance_once_after_the_level(handler):
    line = render(handler, "app.worker", "tick %s", 1)

    assert line.count("instance=svc-a:9001") == 1
    assert "WARNING instance=svc-a:9001 app.worker tick 1" in line


def test_instance_is_the_hostname_and_port_without_service_host(monkeypatch):
    monkeypatch.delenv("SERVICE_HOST", raising=False)
    monkeypatch.setenv("PORT", "9100")
    monkeypatch.setattr(socket, "gethostname", lambda: "box")
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "m", (), None)
    logging_config.InstanceFilter().filter(record)

    assert record.instance == "box:9100"


def test_access_line_keeps_its_fields_and_shows_the_instance_once(handler):
    request = SimpleNamespace(
        method="GET",
        url=SimpleNamespace(path="/nope"),
        headers={},
        state=SimpleNamespace(trace_id="trace-1"),
    )
    seen = []
    capture = logging.Handler()
    capture.emit = lambda record: seen.append(handler.format(record))
    capture.addFilter(handler.filters[0])
    log = logging.getLogger("app.access")
    log.addHandler(capture)
    previous = log.level
    log.setLevel(logging.INFO)
    try:
        logging_config.log_access(request, 404, time.perf_counter())
    finally:
        log.removeHandler(capture)
        log.setLevel(previous)

    (line,) = seen
    assert line.count("instance=") == 1 and "instance=svc-a:9001 app.access GET /nope status=404 duration=" in line
    assert line.endswith("user=- trace_id=trace-1")
