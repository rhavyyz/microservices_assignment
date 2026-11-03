
import pytest

from app.services.storage import CertificateStorage


def test_save_and_read_pdf(tmp_path):
    storage = CertificateStorage(tmp_path)
    pdf_bytes = b"%PDF-1.4 test certificate"

    storage_key = storage.save_pdf(pdf_bytes)

    assert storage_key.endswith(".pdf")
    assert "/" not in storage_key
    assert "\\" not in storage_key
    assert (tmp_path / storage_key).read_bytes() == pdf_bytes
    assert storage.read_pdf(storage_key) == pdf_bytes


def test_save_empty_pdf_is_rejected(tmp_path):
    storage = CertificateStorage(tmp_path)

    with pytest.raises(ValueError, match="must not be empty"):
        storage.save_pdf(b"")


def test_read_missing_pdf_raises_error(tmp_path):
    storage = CertificateStorage(tmp_path)

    with pytest.raises(FileNotFoundError):
        storage.read_pdf("missing.pdf")


@pytest.mark.parametrize(
    "storage_key",
    [
        "../certificate.pdf",
        "..\\certificate.pdf",
        "/tmp/certificate.pdf",
        "",
        "certificate.txt",
    ],
)
def test_invalid_storage_key_is_rejected(tmp_path, storage_key):
    storage = CertificateStorage(tmp_path)

    with pytest.raises(ValueError, match="Invalid certificate storage key"):
        storage.read_pdf(storage_key)
