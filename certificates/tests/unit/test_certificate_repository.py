
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.certificate import Certificate
from app.repositories.certificate_repository import CertificateAlreadyExistsError, CertificateRepository


def test_create_and_retrieve_certificate(tmp_path):
    database_file = tmp_path / "certificates.db"
    engine = create_engine(f"sqlite:///{database_file}")

    Base.metadata.create_all(engine)

    SessionFactory = sessionmaker(
        bind=engine,
        expire_on_commit=False,
    )

    registration_id = uuid.uuid4()

    with SessionFactory() as session:
        repository = CertificateRepository(session)

        created = repository.create(
            registration_id=registration_id,
            user_id=uuid.uuid4(),
            activity_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            file_path="example-certificate.pdf",
        )

        assert created.id is not None
        assert created.registration_id == registration_id
        assert created.file_path == "example-certificate.pdf"

    with SessionFactory() as session:
        repository = CertificateRepository(session)

        retrieved = repository.get_by_registration_id(
            registration_id
        )

        assert retrieved is not None
        assert retrieved.id == created.id
        assert retrieved.file_path == "example-certificate.pdf"

    engine.dispose()


def test_unique_per_user_and_event_even_with_different_registration(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'certificates.db'}")
    Base.metadata.create_all(engine)
    user_id, event_id = uuid.uuid4(), uuid.uuid4()

    def create(repository, **overrides):
        values = {
            "registration_id": uuid.uuid4(),
            "user_id": user_id,
            "activity_id": uuid.uuid4(),
            "event_id": event_id,
            "file_path": "x.pdf",
        }
        values.update(overrides)
        return repository.create(**values)

    with sessionmaker(bind=engine, expire_on_commit=False)() as session:
        repository = CertificateRepository(session)
        first = create(repository)

        assert repository.get_by_user_and_event(user_id, event_id).id == first.id
        assert repository.get_by_user_and_event(user_id, uuid.uuid4()) is None
        assert repository.get_by_user_and_event(uuid.uuid4(), event_id) is None

        # The insert itself hits the unique index; the re-check by both keys turns it into "already exists".
        with pytest.raises(CertificateAlreadyExistsError):
            create(repository)
        create(repository, event_id=uuid.uuid4())  # same user, other event: fine
        create(repository, user_id=uuid.uuid4())  # other user, same event: fine

    engine.dispose()
