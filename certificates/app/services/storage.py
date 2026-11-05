
import uuid
from pathlib import Path

from app.config import settings


class CertificateStorageError(RuntimeError):
    """Raised when a certificate cannot be stored or retrieved."""


class CertificateStorage:
    def __init__(self, storage_dir: str | Path | None = None) -> None:
        self.storage_dir = Path(
            storage_dir if storage_dir is not None
            else settings.certificate_storage_dir
        )

    def save_pdf(self, pdf_bytes: bytes) -> str:
        """Save PDF bytes and return a relative storage key."""
        if not pdf_bytes:
            raise ValueError("PDF content must not be empty")

        self.storage_dir.mkdir(parents=True, exist_ok=True)

        storage_key = f"{uuid.uuid4()}.pdf"
        destination = self.storage_dir / storage_key

        try:
            destination.write_bytes(pdf_bytes)
        except OSError as exc:
            raise CertificateStorageError(
                "Could not save certificate PDF"
            ) from exc

        return storage_key

    def read_pdf(self, storage_key: str) -> bytes:
        """Read a PDF using its relative storage key."""
        if (
            not storage_key
            or Path(storage_key).name != storage_key
            or Path(storage_key).suffix.lower() != ".pdf"
        ):
            raise ValueError("Invalid certificate storage key")

        source = self.storage_dir / storage_key

        try:
            return source.read_bytes()
        except FileNotFoundError as exc:
            raise FileNotFoundError(
                "Certificate PDF was not found"
            ) from exc
        except OSError as exc:
            raise CertificateStorageError(
                "Could not read certificate PDF"
            ) from exc

    
    def delete_pdf(self, storage_key: str) -> None:
        """Delete a PDF using its relative storage key."""
        if (
            not storage_key
            or Path(storage_key).name != storage_key
            or Path(storage_key).suffix.lower() != ".pdf"
        ):
            raise ValueError("Invalid certificate storage key")

        source = self.storage_dir / storage_key

        try:
            source.unlink(missing_ok=True)
        except OSError as exc:
            raise CertificateStorageError(
                "Could not delete certificate PDF"
            ) from exc
