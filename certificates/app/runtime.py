"""Background work started by the lifespan. None of it may block startup or /healthcheck."""

import logging
import threading

from app.config import settings
from app.consumer import AttendanceWorker
from app.integrations.discovery import register_service
from app.services.storage import S3CertificateStorage, get_storage

log = logging.getLogger(__name__)

REGISTRATION_INTERVAL = 30


class Runtime:
    def __init__(self) -> None:
        self.stop = threading.Event()
        self.threads: list[threading.Thread] = []
        self.worker: AttendanceWorker | None = None

    def start(self) -> None:
        targets = [self.register]
        if settings.certificate_storage_backend.strip().lower() == "s3":
            targets.append(self.ensure_bucket)
        for target in targets:
            thread = threading.Thread(target=target, name=target.__name__, daemon=True)
            thread.start()
            self.threads.append(thread)

        self.worker = AttendanceWorker()
        self.worker.start()

    def close(self) -> None:
        self.stop.set()
        if self.worker is not None:
            self.worker.close()
        for thread in self.threads:
            thread.join(timeout=5)

    def register(self) -> None:
        # register() blocks while retrying (about 2.5 min) and the discoverer's registry is volatile, so it runs
        # in a thread and repeats: a restarted discoverer would otherwise never see this service again.
        while not self.stop.is_set():
            try:
                register_service()
            except Exception:
                log.warning("discovery_registration_failed")
            self.stop.wait(REGISTRATION_INTERVAL)

    def ensure_bucket(self) -> None:
        delay = 2
        while not self.stop.is_set():
            try:
                storage = get_storage()
                if isinstance(storage, S3CertificateStorage):
                    storage.ensure_bucket()
            except Exception:
                log.warning("bucket_ensure_failed")
                self.stop.wait(delay)
                delay = min(delay * 2, 30)
                continue
            log.info("bucket_ready")
            return
