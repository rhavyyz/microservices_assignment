import threading
import time

from fastapi.testclient import TestClient

from app import runtime
from app.config import settings
from app.main import app

def test_boots_and_serves_with_kafka_and_discoverer_unreachable(monkeypatch):
    registered = threading.Event()
    ensured = threading.Event()

    def unreachable_discoverer():
        registered.set()
        raise RuntimeError("could not register with the service-discoverer")

    def unreachable_kafka(brokers, topics, partitions):
        ensured.set()
        raise RuntimeError("kafka down")

    monkeypatch.setattr(settings, "workers_enabled", True)
    monkeypatch.setattr(settings, "certificate_storage_backend", "local")
    monkeypatch.setattr(runtime, "register_service", unreachable_discoverer)
    monkeypatch.setattr("app.consumer.ensure_topics", unreachable_kafka)
    monkeypatch.setattr(runtime, "REGISTRATION_INTERVAL", 0.05)

    started = time.monotonic()
    with TestClient(app) as client:
        assert time.monotonic() - started < 5
        assert client.get("/openapi.json").status_code == 200
        assert client.get("/healthcheck").status_code == 503  # no database configured, but it answers
        assert registered.wait(2)
        assert ensured.wait(2)
    assert time.monotonic() - started < 20
