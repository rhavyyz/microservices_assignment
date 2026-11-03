
import uuid
from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.repositories.certificate_repository import CertificateAlreadyExistsError
from app.services.certificate_service import (
    CertificateNotEligibleError,
    CertificateNotFoundError,
    CertificateService,
)
from app.services.storage import CertificateStorage


@pytest.fixture
def service_environment(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'certificates.db'}")
    Base.metadata.create_all(engine)

    session_factory = sessionmaker(
        bind=engine,
        expire_on_commit=False,
    )
    session = session_factory()
    storage = CertificateStorage(tmp_path / "pdfs")
    service = CertificateService(session, storage)

    yield service, storage

    session.close()
    engine.dispose()


def test_issue_and_retrieve_certificate(service_environment):
    service, storage = service_environment
    registration_id = uuid.uuid4()

    certificate = service.issue_certificate(
        registration_id=registration_id,
        participant_name="Alex Example",
        event_name="Software Engineering Conference",
        event_date=date(2026, 10, 20),
        event_ended=True,
        attendance_percentage=85,
    )

    assert certificate.registration_id == registration_id
    assert certificate.file_path.endswith(".pdf")

    retrieved, pdf_bytes = service.get_certificate_pdf(certificate.id)

    assert retrieved.id == certificate.id
    assert pdf_bytes.startswith(b"%PDF")
    assert storage.read_pdf(certificate.file_path) == pdf_bytes


def test_ineligible_participant_does_not_receive_certificate(
    service_environment,
):
    service, storage = service_environment

    with pytest.raises(CertificateNotEligibleError):
        service.issue_certificate(
            registration_id=uuid.uuid4(),
            participant_name="Alex Example",
            event_name="Software Engineering Conference",
            event_date=date(2026, 10, 20),
            event_ended=True,
            attendance_percentage=74,
        )

    assert not list(storage.storage_dir.glob("*.pdf"))


def test_duplicate_registration_is_rejected(service_environment):
    service, storage = service_environment
    registration_id = uuid.uuid4()

    arguments = {
        "registration_id": registration_id,
        "participant_name": "Alex Example",
        "event_name": "Software Engineering Conference",
        "event_date": date(2026, 10, 20),
        "event_ended": True,
        "attendance_percentage": 90,
    }

    service.issue_certificate(**arguments)

    with pytest.raises(CertificateAlreadyExistsError):
        service.issue_certificate(**arguments)

    assert len(list(storage.storage_dir.glob("*.pdf"))) == 1


def test_missing_certificate_is_not_found(service_environment):
    service, _ = service_environment

    with pytest.raises(CertificateNotFoundError):
        service.get_certificate_pdf(uuid.uuid4())
