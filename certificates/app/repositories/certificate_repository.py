
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

    def list_by_user(
        self,
        user_id: uuid.UUID,
        *,
        limit: int,
        offset: int,
    ) -> list[Certificate]:
        statement = (
            select(Certificate)
            .where(Certificate.user_id == user_id)
            .order_by(Certificate.issued_at.desc(), Certificate.id.desc())
            .limit(limit)
            .offset(offset)
        )

        return list(self.session.scalars(statement))

    def create(
        self,
        *,
        registration_id: uuid.UUID,
        user_id: uuid.UUID,
        activity_id: uuid.UUID,
        file_path: str,
    ) -> Certificate:
        certificate = Certificate(
            registration_id=registration_id,
            user_id=user_id,
            activity_id=activity_id,
            file_path=file_path,
        )

        self.session.add(certificate)

        try:
            self.session.commit()
            self.session.refresh(certificate)
        except IntegrityError as exc:
            self.session.rollback()
            # Lost a race on the unique registration_id; any other violation is a real error.
            if self.get_by_registration_id(registration_id) is None:
                raise
            raise CertificateAlreadyExistsError(
                "A certificate already exists for this registration"
            ) from exc
        except Exception:
            self.session.rollback()
            raise

        return certificate
