
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Protocol

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.config import settings


class CertificateStorageError(RuntimeError):
    """Raised when a certificate cannot be stored or retrieved."""


class BlobStorage(Protocol):
    """Where generated PDFs live. Keys are opaque `<uuid>.pdf` names, never paths."""

    def save_pdf(self, pdf_bytes: bytes) -> str:
        """Save PDF bytes and return an opaque storage key."""

    def read_pdf(self, storage_key: str) -> bytes:
        """Read a PDF; raises FileNotFoundError if the key does not exist."""

    def delete_pdf(self, storage_key: str) -> None:
        """Delete a PDF; deleting a missing key is not an error."""


def validate_storage_key(storage_key: str) -> None:
    if (
        not storage_key
        or "/" in storage_key
        or "\\" in storage_key
        or Path(storage_key).name != storage_key
        or Path(storage_key).suffix.lower() != ".pdf"
    ):
        raise ValueError("Invalid certificate storage key")


def _new_storage_key(pdf_bytes: bytes) -> str:
    if not pdf_bytes:
        raise ValueError("PDF content must not be empty")

    return f"{uuid.uuid4()}.pdf"


class CertificateStorage:
    """Local filesystem backend."""

    def __init__(self, storage_dir: str | Path | None = None) -> None:
        self.storage_dir = Path(
            storage_dir if storage_dir is not None
            else settings.certificate_storage_dir
        )

    def save_pdf(self, pdf_bytes: bytes) -> str:
        """Save PDF bytes and return a relative storage key."""
        storage_key = _new_storage_key(pdf_bytes)

        try:
            self.storage_dir.mkdir(parents=True, exist_ok=True)
            (self.storage_dir / storage_key).write_bytes(pdf_bytes)
        except OSError as exc:
            raise CertificateStorageError(
                "Could not save certificate PDF"
            ) from exc

        return storage_key

    def read_pdf(self, storage_key: str) -> bytes:
        """Read a PDF using its relative storage key."""
        validate_storage_key(storage_key)

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
        validate_storage_key(storage_key)

        source = self.storage_dir / storage_key

        try:
            source.unlink(missing_ok=True)
        except OSError as exc:
            raise CertificateStorageError(
                "Could not delete certificate PDF"
            ) from exc


_MISSING_CODES = {"NoSuchKey", "404", "NotFound"}
_MISSING_BUCKET_CODES = {"NoSuchBucket", "404", "NotFound"}


class S3CertificateStorage:
    """S3-compatible backend (SeaweedFS in the compose stack). Errors never carry endpoint or credentials."""

    def __init__(self, client, bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    def ensure_bucket(self) -> None:
        """Create the bucket if it does not exist. Raises CertificateStorageError if the store is unreachable."""
        try:
            self.client.head_bucket(Bucket=self.bucket)
            return
        except ClientError as exc:
            if _error_code(exc) not in _MISSING_BUCKET_CODES:
                raise CertificateStorageError("Could not check certificate bucket") from exc
        except BotoCoreError as exc:
            raise CertificateStorageError("Could not check certificate bucket") from exc

        try:
            self.client.create_bucket(Bucket=self.bucket)
        except ClientError as exc:
            # Another replica may have created it between the check and now.
            if _error_code(exc) not in {"BucketAlreadyOwnedByYou", "BucketAlreadyExists"}:
                raise CertificateStorageError("Could not create certificate bucket") from exc
        except BotoCoreError as exc:
            raise CertificateStorageError("Could not create certificate bucket") from exc

    def save_pdf(self, pdf_bytes: bytes) -> str:
        storage_key = _new_storage_key(pdf_bytes)

        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=storage_key,
                Body=pdf_bytes,
                ContentType="application/pdf",
            )
        except (ClientError, BotoCoreError) as exc:
            raise CertificateStorageError("Could not save certificate PDF") from exc

        return storage_key

    def read_pdf(self, storage_key: str) -> bytes:
        validate_storage_key(storage_key)

        try:
            return self.client.get_object(Bucket=self.bucket, Key=storage_key)["Body"].read()
        except ClientError as exc:
            if _error_code(exc) in _MISSING_CODES:
                raise FileNotFoundError("Certificate PDF was not found") from exc
            raise CertificateStorageError("Could not read certificate PDF") from exc
        except BotoCoreError as exc:
            raise CertificateStorageError("Could not read certificate PDF") from exc

    def delete_pdf(self, storage_key: str) -> None:
        validate_storage_key(storage_key)

        try:
            self.client.delete_object(Bucket=self.bucket, Key=storage_key)
        except (ClientError, BotoCoreError) as exc:
            raise CertificateStorageError("Could not delete certificate PDF") from exc


def _error_code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


def build_s3_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},  # the compose S3 gateway has no per-bucket DNS names
            connect_timeout=3,
            read_timeout=10,
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


@lru_cache(maxsize=1)
def get_storage() -> BlobStorage:
    """The one place that picks the backend from CERTIFICATE_STORAGE_BACKEND."""
    backend = settings.certificate_storage_backend.strip().lower()

    if backend == "local":
        return CertificateStorage()
    if backend == "s3":
        return S3CertificateStorage(build_s3_client(), settings.s3_bucket)

    raise ValueError("CERTIFICATE_STORAGE_BACKEND must be 'local' or 's3'")
