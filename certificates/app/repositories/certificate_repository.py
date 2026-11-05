
import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.certificate import Certificate


class CertificateAlreadyExistsError(RuntimeError):
    """A certificate already exists for this registration."""


class CertificateRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get_by_registration_id(
        self,
        registration_id: uuid.UUID,
    ) -> Certificate | None:
        statement = select(Certificate).where(
            Certificate.registration_id == registration_id
        )

        return self.session.scalar(statement)

    def get_by_id(
        self,
        certificate_id: uuid.UUID,
    ) -> Certificate | None:
        return self.session.get(Certificate, certificate_id)

    def create(
        self,
        *,
        registration_id: uuid.UUID,
        file_path: str,
    ) -> Certificate:
        certificate = Certificate(
            registration_id=registration_id,
            file_path=file_path,
        )

        self.session.add(certificate)

        try:
            self.session.commit()
            self.session.refresh(certificate)
        except IntegrityError as exc:
            self.session.rollback()
            raise CertificateAlreadyExistsError(
                "A certificate already exists for this registration"
            ) from exc
        except Exception:
            self.session.rollback()
            raise

        return certificate
