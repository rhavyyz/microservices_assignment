
import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.certificate import Certificate
from app.repositories.certificate_repository import CertificateRepository


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
