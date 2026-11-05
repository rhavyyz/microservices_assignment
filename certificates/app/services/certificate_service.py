
import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models.certificate import Certificate
from app.repositories.certificate_repository import (
    CertificateAlreadyExistsError,
    CertificateRepository,
)
from app.services.eligibility import is_eligible
from app.services.pdf_generator import generate_certificate_pdf
from app.services.storage import BlobStorage, get_storage


class CertificateNotEligibleError(ValueError):
    """The participant does not meet the certificate eligibility rules."""


class CertificateNotFoundError(LookupError):
    """The requested certificate does not exist."""


class CertificateService:
    def __init__(
        self,
        session: Session,
        storage: BlobStorage | None = None,
    ) -> None:
        self.repository = CertificateRepository(session)
        self.storage = storage or get_storage()

    def issue_certificate(
        self,
        *,
        registration_id: uuid.UUID,
        user_id: uuid.UUID,
        activity_id: uuid.UUID,
        event_id: uuid.UUID,
        participant_name: str,
        event_name: str,
        event_date: date,
        event_ended: bool,
        attendance_percentage: Decimal | int | float | str,
    ) -> Certificate:
        """Validate eligibility, generate a PDF, and persist its metadata."""
        if not is_eligible(
            event_ended=event_ended,
            attendance_percentage=attendance_percentage,
        ):
            raise CertificateNotEligibleError(
                "The participant does not meet the certificate eligibility rules"
            )

        existing = self.repository.get_by_registration_id(registration_id)
        if existing is not None:
            raise CertificateAlreadyExistsError(
                "A certificate already exists for this registration"
            )
        if self.repository.get_by_user_and_event(user_id, event_id) is not None:
            raise CertificateAlreadyExistsError(
                "A certificate already exists for this user and event"
            )

        pdf_bytes = generate_certificate_pdf(
            participant_name=participant_name,
            event_name=event_name,
            event_date=event_date,
        )

        storage_key = self.storage.save_pdf(pdf_bytes)

        try:
            return self.repository.create(
                registration_id=registration_id,
                user_id=user_id,
                activity_id=activity_id,
                event_id=event_id,
                file_path=storage_key,
            )
        except Exception:
            # Preserve the original error if cleanup also fails.
            try:
                self.storage.delete_pdf(storage_key)
            except Exception:
                pass
            raise

    def get_certificate_pdf(
        self,
        certificate_id: uuid.UUID,
        owner_id: uuid.UUID | None = None,
    ) -> tuple[Certificate, bytes]:
        """Return certificate metadata and its PDF bytes.

        With `owner_id`, a certificate of someone else is reported as not found,
        exactly like a nonexistent one.
        """
        certificate = self.repository.get_by_id(certificate_id)

        if certificate is None or (
            owner_id is not None and certificate.user_id != owner_id
        ):
            raise CertificateNotFoundError(
                "Certificate was not found"
            )

        pdf_bytes = self.storage.read_pdf(certificate.file_path)
        return certificate, pdf_bytes

    def list_user_certificates(
        self,
        user_id: uuid.UUID,
        *,
        limit: int,
        offset: int,
    ) -> list[Certificate]:
        """Certificates of one user, newest first."""
        return self.repository.list_by_user(user_id, limit=limit, offset=offset)
