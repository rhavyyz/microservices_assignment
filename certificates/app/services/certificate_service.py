
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
from app.services.storage import CertificateStorage


class CertificateNotEligibleError(ValueError):
    """The participant does not meet the certificate eligibility rules."""


class CertificateNotFoundError(LookupError):
    """The requested certificate does not exist."""


class CertificateService:
    def __init__(
        self,
        session: Session,
        storage: CertificateStorage | None = None,
    ) -> None:
        self.repository = CertificateRepository(session)
        self.storage = storage or CertificateStorage()

    def issue_certificate(
        self,
        *,
        registration_id: uuid.UUID,
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

        pdf_bytes = generate_certificate_pdf(
            participant_name=participant_name,
            event_name=event_name,
            event_date=event_date,
        )

        storage_key = self.storage.save_pdf(pdf_bytes)

        try:
            return self.repository.create(
                registration_id=registration_id,
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
    ) -> tuple[Certificate, bytes]:
        """Return certificate metadata and its PDF bytes."""
        certificate = self.repository.get_by_id(certificate_id)

        if certificate is None:
            raise CertificateNotFoundError(
                "Certificate was not found"
            )

        pdf_bytes = self.storage.read_pdf(certificate.file_path)
        return certificate, pdf_bytes
