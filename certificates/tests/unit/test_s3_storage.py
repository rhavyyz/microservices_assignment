import io

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from app.config import settings
from app.services import storage as storage_module
from app.services.storage import (
    CertificateStorage,
    CertificateStorageError,
    S3CertificateStorage,
    get_storage,
)


def client_error(code, operation="Op"):
    return ClientError({"Error": {"Code": code, "Message": "secret endpoint detail"}}, operation)


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.buckets = set()
        self.calls = []
        self.fail = None

    def _maybe_fail(self, name):
        self.calls.append(name)
        if self.fail:
            raise self.fail

    def head_bucket(self, Bucket):
        self._maybe_fail("head_bucket")
        if Bucket not in self.buckets:
            raise client_error("404", "HeadBucket")

    def create_bucket(self, Bucket):
        self._maybe_fail("create_bucket")
        self.buckets.add(Bucket)

    def put_object(self, Bucket, Key, Body, ContentType):
        self._maybe_fail("put_object")
        assert ContentType == "application/pdf"
        self.objects[(Bucket, Key)] = Body

    def get_object(self, Bucket, Key):
        self._maybe_fail("get_object")
        if (Bucket, Key) not in self.objects:
            raise client_error("NoSuchKey", "GetObject")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def delete_object(self, Bucket, Key):
        self._maybe_fail("delete_object")
        self.objects.pop((Bucket, Key), None)


@pytest.fixture
def s3():
    return FakeS3()


@pytest.fixture
def storage(s3):
    return S3CertificateStorage(s3, "certificates")


def test_save_read_delete_roundtrip(storage, s3):
    key = storage.save_pdf(b"%PDF-1.4 x")

    assert key.endswith(".pdf") and "/" not in key
    assert storage.read_pdf(key) == b"%PDF-1.4 x"
    storage.delete_pdf(key)
    storage.delete_pdf(key)
    with pytest.raises(FileNotFoundError):
        storage.read_pdf(key)


def test_empty_pdf_is_rejected(storage):
    with pytest.raises(ValueError, match="must not be empty"):
        storage.save_pdf(b"")


@pytest.mark.parametrize("key", ["../a.pdf", "..\\a.pdf", "/tmp/a.pdf", "", "a.txt", "dir/a.pdf"])
def test_invalid_keys_are_rejected_without_calling_s3(storage, s3, key):
    for operation in (storage.read_pdf, storage.delete_pdf):
        with pytest.raises(ValueError, match="Invalid certificate storage key"):
            operation(key)

    assert s3.calls == []


@pytest.mark.parametrize("error", [client_error("InternalError"), EndpointConnectionError(endpoint_url="http://secret:9000")])
def test_errors_map_to_storage_error_without_details(storage, s3, error):
    key = storage.save_pdf(b"x")
    s3.fail = error

    for call in (lambda: storage.save_pdf(b"x"), lambda: storage.read_pdf(key), lambda: storage.delete_pdf(key)):
        with pytest.raises(CertificateStorageError) as raised:
            call()
        assert "secret" not in str(raised.value)


def test_ensure_bucket_creates_when_absent_and_is_idempotent(storage, s3):
    storage.ensure_bucket()
    storage.ensure_bucket()

    assert s3.buckets == {"certificates"}
    assert s3.calls.count("create_bucket") == 1


def test_ensure_bucket_tolerates_concurrent_creation(storage, s3):
    def racing_create(Bucket):
        raise client_error("BucketAlreadyOwnedByYou", "CreateBucket")

    s3.create_bucket = racing_create

    storage.ensure_bucket()


def test_ensure_bucket_reports_unreachable_store(storage, s3):
    s3.fail = EndpointConnectionError(endpoint_url="http://secret:9000")

    with pytest.raises(CertificateStorageError):
        storage.ensure_bucket()


def test_ensure_bucket_reports_denied_access(storage, s3):
    s3.fail = client_error("403", "HeadBucket")

    with pytest.raises(CertificateStorageError):
        storage.ensure_bucket()
    assert "create_bucket" not in s3.calls


def test_factory_picks_backend_from_settings(monkeypatch):
    monkeypatch.setattr(settings, "certificate_storage_backend", "local")
    get_storage.cache_clear()
    assert isinstance(get_storage(), CertificateStorage)

    monkeypatch.setattr(settings, "certificate_storage_backend", "S3")
    monkeypatch.setattr(settings, "s3_endpoint_url", "http://certificates-s3:8333")
    monkeypatch.setattr(settings, "s3_access_key", "k")
    monkeypatch.setattr(settings, "s3_secret_key", "s")
    get_storage.cache_clear()
    built = get_storage()
    assert isinstance(built, S3CertificateStorage)
    assert built.bucket == settings.s3_bucket
    assert built.client.meta.endpoint_url == "http://certificates-s3:8333"
    assert built.client.meta.config.s3["addressing_style"] == "path"
    assert built.client.meta.config.connect_timeout == 3

    monkeypatch.setattr(settings, "certificate_storage_backend", "gcs")
    get_storage.cache_clear()
    with pytest.raises(ValueError, match="CERTIFICATE_STORAGE_BACKEND"):
        get_storage()

    get_storage.cache_clear()
