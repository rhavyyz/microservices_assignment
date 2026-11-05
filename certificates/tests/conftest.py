import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


@pytest.fixture
def client(monkeypatch):
    # No discoverer registration, bucket check or Kafka consumer in unit tests.
    monkeypatch.setattr(settings, "workers_enabled", False)
    with TestClient(app) as test_client:
        yield test_client
