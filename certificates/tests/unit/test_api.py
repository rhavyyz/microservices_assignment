import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app
from app.config import settings
from app.services.certificate_service import CertificateService
from app.services.storage import CertificateStorage, get_storage

ALEX = uuid.uuid4()
BLAIR = uuid.uuid4()


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workers_enabled", False)
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    storage = CertificateStorage(tmp_path / "pdfs")

    def override_db():
        session = factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_storage] = lambda: storage

    from fastapi.testclient import TestClient

    with TestClient(app) as client, factory() as session:
        yield client, CertificateService(session, storage), storage

    app.dependency_overrides.clear()
    engine.dispose()


def issue(service, user_id):
    return service.issue_certificate(
        registration_id=uuid.uuid4(),
        user_id=user_id,
        activity_id=uuid.uuid4(),
        participant_name="Alex Example",
        event_name="Conference",
        event_date=date(2026, 10, 20),
        event_ended=True,
        attendance_percentage=100,
    )


def as_user(user_id):
    return {"X-User-Id": str(user_id)}


@pytest.mark.parametrize("headers", [{}, {"X-User-Id": ""}, {"X-User-Id": "not-a-uuid"}])
@pytest.mark.parametrize("path", ["/api/v1/certificates/me", f"/api/v1/certificates/{uuid.uuid4()}"])
def test_missing_or_invalid_identity_is_401_problem(env, path, headers):
    client, _, _ = env

    response = client.get(path, headers=headers)

    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["code"] == "UNAUTHENTICATED"
    assert body["status"] == 401
    assert body["title"] == "UNAUTHENTICATED"
    assert body["traceId"] == response.headers["X-Request-Id"]


def test_request_id_is_echoed_when_valid_and_replaced_otherwise(env):
    client, _, _ = env

    kept = client.get("/api/v1/certificates/me", headers={"X-Request-Id": "trace-12345678"})
    replaced = client.get("/api/v1/certificates/me", headers={"X-Request-Id": "bad id!"})

    assert kept.json()["traceId"] == "trace-12345678"
    assert kept.headers["X-Request-Id"] == "trace-12345678"
    assert replaced.headers["X-Request-Id"] != "bad id!"
    uuid.UUID(replaced.headers["X-Request-Id"])


def test_me_lists_only_own_certificates_newest_first(env):
    client, service, _ = env
    first = issue(service, ALEX)
    second = issue(service, ALEX)
    issue(service, BLAIR)
    # Force a deterministic order regardless of clock resolution.
    first.issued_at = datetime.now(timezone.utc) - timedelta(days=1)
    service.repository.session.commit()

    response = client.get("/api/v1/certificates/me", headers=as_user(ALEX))

    assert response.status_code == 200
    items = response.json()["certificates"]
    assert [item["id"] for item in items] == [str(second.id), str(first.id)]
    assert set(items[0]) == {"id", "registration_id", "activity_id", "issued_at"}


def test_me_pagination_and_limits(env):
    client, service, _ = env
    for _ in range(3):
        issue(service, ALEX)

    page1 = client.get("/api/v1/certificates/me?limit=2", headers=as_user(ALEX)).json()["certificates"]
    page2 = client.get("/api/v1/certificates/me?limit=2&offset=2", headers=as_user(ALEX)).json()["certificates"]

    assert len(page1) == 2 and len(page2) == 1
    assert not {c["id"] for c in page1} & {c["id"] for c in page2}
    for query in ("limit=0", "limit=101", "offset=-1", "limit=abc"):
        response = client.get(f"/api/v1/certificates/me?{query}", headers=as_user(ALEX))
        assert response.status_code == 400
        assert response.json()["code"] == "INVALID_REQUEST"


def test_me_is_empty_for_user_without_certificates(env):
    client, _, _ = env

    response = client.get("/api/v1/certificates/me", headers=as_user(ALEX))

    assert response.json() == {"certificates": []}


def test_owner_downloads_pdf_attachment(env):
    client, service, storage = env
    certificate = issue(service, ALEX)

    response = client.get(f"/api/v1/certificates/{certificate.id}", headers=as_user(ALEX))

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == f'attachment; filename="certificate-{certificate.id}.pdf"'
    assert response.content == storage.read_pdf(certificate.file_path)
    assert response.content.startswith(b"%PDF")


def test_other_users_and_unknown_ids_get_the_same_404(env):
    client, service, _ = env
    certificate = issue(service, ALEX)

    foreign = client.get(f"/api/v1/certificates/{certificate.id}", headers=as_user(BLAIR))
    unknown = client.get(f"/api/v1/certificates/{uuid.uuid4()}", headers=as_user(BLAIR))

    assert foreign.status_code == unknown.status_code == 404
    assert foreign.headers["content-type"].startswith("application/problem+json")
    assert foreign.json()["code"] == unknown.json()["code"] == "NOT_FOUND"
    assert foreign.content != b"" and b"%PDF" not in foreign.content


def test_legacy_certificate_without_user_is_never_served(env):
    client, service, _ = env
    certificate = issue(service, ALEX)
    certificate.user_id = None
    service.repository.session.commit()

    response = client.get(f"/api/v1/certificates/{certificate.id}", headers=as_user(ALEX))

    assert response.status_code == 404


def test_missing_blob_is_503_without_leaking_paths(env):
    client, service, storage = env
    certificate = issue(service, ALEX)
    (storage.storage_dir / certificate.file_path).unlink()

    response = client.get(f"/api/v1/certificates/{certificate.id}", headers=as_user(ALEX))

    assert response.status_code == 503
    assert response.json()["code"] == "STORAGE_UNAVAILABLE"
    assert certificate.file_path not in response.text
    assert str(storage.storage_dir) not in response.text


def test_non_uuid_certificate_id_is_400_after_authentication(env):
    client, _, _ = env

    assert client.get("/api/v1/certificates/abc", headers=as_user(ALEX)).status_code == 400
    assert client.get("/api/v1/certificates/abc").status_code == 401


def test_database_down_is_503_problem(client):
    # No get_db override: DATABASE_URL is not configured in tests.
    response = client.get("/api/v1/certificates/me", headers=as_user(ALEX))

    assert response.status_code == 503
    assert response.json()["code"] == "DATABASE_UNAVAILABLE"
