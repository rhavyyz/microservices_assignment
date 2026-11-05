"""Certificates are created only here, from Subscription's `AttendanceEligible` events (ADR-006).

Delivery is at least once: the offset is committed after processing, and a redelivered event is a
no-op because a certificate is unique per registration and per (user, event). The event is not trusted
on its own; see AttendanceHandler.
"""

import json
import logging
import math
import threading
import uuid
from collections.abc import Callable
from datetime import datetime, timezone

from confluent_kafka import Consumer, Producer, TopicPartition

from app.config import settings
from app.database import get_session_factory
from app.integrations.directory import Directory, PoisonMessage, TransientError
from app.integrations.topics import ensure_topics
from app.repositories.certificate_repository import CertificateAlreadyExistsError
from app.services.certificate_service import CertificateNotEligibleError, CertificateService
from app.services.storage import CertificateStorageError, get_storage

log = logging.getLogger(__name__)

ELIGIBLE_TYPE = "AttendanceEligible"
SCHEMA_VERSION = 1
CONSUMER_GROUP = "certificates-service"

# The percentage is computed by Subscription over the event's activities and is re-checked here: it must be
# consistent with the counts (within one hundredth, the rounding Subscription applies).
PERCENTAGE_TOLERANCE = 0.01 + 1e-9


def _uuid(payload: dict, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(payload[field]))
    except (KeyError, ValueError):
        raise PoisonMessage("INVALID_CONTRACT") from None


def _int(payload: dict, field: str) -> int:
    value = payload.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise PoisonMessage("INVALID_CONTRACT")
    return value


def _attendance(payload: dict) -> tuple[int, int, float]:
    """attended, total and the percentage, checked for shape and for consistency with each other."""
    attended = _int(payload, "attended_activities")
    total = _int(payload, "total_activities")
    if total < 1 or not 0 <= attended <= total:
        raise PoisonMessage("INVALID_CONTRACT")
    percentage = payload.get("attendance_percentage")
    if isinstance(percentage, bool) or not isinstance(percentage, (int, float)) or not math.isfinite(percentage):
        raise PoisonMessage("INVALID_CONTRACT")
    if abs(percentage - round(attended * 100 / total, 2)) > PERCENTAGE_TOLERANCE:
        raise PoisonMessage("INVALID_CONTRACT")
    return attended, total, percentage


class AttendanceHandler:
    """Turns one raw Kafka message into a certificate, or raises PoisonMessage / TransientError."""

    def __init__(
        self,
        directory=None,
        session_factory: Callable | None = None,
        storage_factory: Callable | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self.directory = directory or Directory()
        self.session_factory = session_factory or (lambda: get_session_factory()())
        self.storage_factory = storage_factory or get_storage
        self.clock = clock

    def handle(self, raw: bytes | None) -> None:
        try:
            payload = json.loads(raw or b"")
        except (ValueError, UnicodeError):
            raise PoisonMessage("INVALID_JSON") from None
        if not isinstance(payload, dict):
            raise PoisonMessage("INVALID_CONTRACT")

        # Every other type, including types this version does not know, is acknowledged and ignored.
        if payload.get("type") != ELIGIBLE_TYPE:
            return

        if payload.get("schema_version") != SCHEMA_VERSION or isinstance(payload.get("schema_version"), bool):
            raise PoisonMessage("UNSUPPORTED_SCHEMA_VERSION")
        registration_id = _uuid(payload, "registration_id")
        activity_id = _uuid(payload, "activity_id")
        user_id = _uuid(payload, "user_id")
        parent_event_id = _uuid(payload, "parent_event_id")
        _, _, attendance_percentage = _attendance(payload)

        request_id = str(uuid.uuid4())
        log.info("attendance_eligible_received registration_id=%s request_id=%s", registration_id, request_id)

        try:
            self._issue(registration_id, activity_id, user_id, parent_event_id, attendance_percentage, request_id)
        except (PoisonMessage, TransientError):
            raise
        except CertificateAlreadyExistsError:
            log.info("certificate_already_issued registration_id=%s", registration_id)
        except CertificateNotEligibleError:
            raise PoisonMessage("NOT_ELIGIBLE") from None
        except CertificateStorageError:
            raise TransientError("storage unavailable") from None
        except Exception as exc:
            # Unexpected: never crash the consumer, never skip the message. Type only (messages may carry data).
            raise TransientError(f"unexpected {type(exc).__name__}") from None

    def _issue(
        self,
        registration_id: uuid.UUID,
        activity_id: uuid.UUID,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        attendance_percentage: float,
        request_id: str,
    ) -> None:
        session = self.session_factory()
        try:
            service = CertificateService(session, self.storage_factory())

            # Cheap idempotency check first: a redelivered event, or a second one for the same user and event,
            # needs no lookups (first completion wins).
            if (
                service.repository.get_by_registration_id(registration_id) is not None
                or service.repository.get_by_user_and_event(user_id, event_id) is not None
            ):
                log.info("certificate_already_issued registration_id=%s", registration_id)
                return

            event = self.directory.get_event(event_id, request_id)
            if self.clock() < event.ends_at:
                # Subscription only emits after the last activity ends, so this is clock skew or an early event.
                raise TransientError("event has not ended yet")

            participant_name = self.directory.get_participant_name(user_id, request_id)

            service.issue_certificate(
                registration_id=registration_id,
                user_id=user_id,
                activity_id=activity_id,
                event_id=event_id,
                participant_name=participant_name,
                event_name=event.title,
                event_date=event.starts_at.date(),
                event_ended=True,
                attendance_percentage=attendance_percentage,
            )
            log.info("certificate_issued registration_id=%s", registration_id)
        finally:
            session.close()


class AttendanceWorker:
    """Daemon-thread Kafka loop: ensure topics, consume, process, commit after processing."""

    def __init__(self, handler=None, consumer_factory=None, producer_factory=None, topics_ensurer=None):
        self.handler = handler or AttendanceHandler()
        # Resolved here, not as default arguments, so they can be replaced in tests.
        self.consumer_factory = consumer_factory or Consumer
        self.producer_factory = producer_factory or Producer
        self.topics_ensurer = topics_ensurer or ensure_topics
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None
        self.producer = None
        self.delay = 2.0

    def start(self) -> None:
        self.thread = threading.Thread(target=self.run, name="attendance-consumer", daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=15)

    def ensure(self) -> bool:
        # Topics created after a consumer subscribed are only seen after a metadata refresh; creating
        # them first avoids the wait. Kafka being down must not stop the service from booting.
        delay = 2
        while not self.stop.is_set():
            try:
                self.topics_ensurer(
                    settings.kafka_brokers,
                    [settings.subscription_events_topic, settings.certificates_dlq_topic],
                    settings.certificates_topic_partitions,
                )
            except Exception:
                log.warning("kafka_topics_ensure_failed")
                self.stop.wait(delay)
                delay = min(delay * 2, 30)
                continue
            log.info("kafka_topics_ready")
            return True
        return False

    def run(self) -> None:
        if not self.ensure():
            return
        config = {
            "bootstrap.servers": settings.kafka_brokers,
            "group.id": CONSUMER_GROUP,
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
            "enable.auto.offset.store": False,
            "max.poll.interval.ms": 300000,
            "topic.metadata.refresh.interval.ms": 10000,
        }
        while not self.stop.is_set():
            consumer = self.consumer_factory(config)
            try:
                consumer.subscribe([settings.subscription_events_topic])
                while not self.stop.is_set():
                    message = consumer.poll(1)
                    if message is None:
                        continue
                    if message.error():
                        log.warning("kafka_poll_failed")
                        self.stop.wait(2)
                        continue
                    self.process(consumer, message)
            except Exception:
                # Recreating the consumer resumes from the last committed offset.
                log.warning("kafka_consumer_failed")
                self.stop.wait(2)
            finally:
                try:
                    consumer.close()
                except Exception:
                    pass

    def process(self, consumer, message) -> None:
        """Handle one message. Commit on success or poison; on a transient failure seek back and back off."""
        try:
            self.handler.handle(message.value())
        except PoisonMessage as exc:
            try:
                self.quarantine(message, exc.reason)
            except Exception:
                log.warning("dlq_publish_failed topic=%s partition=%s offset=%s",
                            message.topic(), message.partition(), message.offset())
                self.retry_later(consumer, message)
                return
            log.warning("poison_message topic=%s partition=%s offset=%s reason=%s",
                        message.topic(), message.partition(), message.offset(), exc.reason)
        except TransientError as exc:
            log.warning("transient_failure topic=%s partition=%s offset=%s cause=%s",
                        message.topic(), message.partition(), message.offset(), exc)
            self.retry_later(consumer, message)
            return
        except Exception as exc:
            log.warning("unexpected_failure topic=%s partition=%s offset=%s cause=%s",
                        message.topic(), message.partition(), message.offset(), type(exc).__name__)
            self.retry_later(consumer, message)
            return

        consumer.commit(message=message, asynchronous=False)
        self.delay = 2.0

    def retry_later(self, consumer, message) -> None:
        # Not committing keeps the offset; seeking back makes the next poll return this same message.
        consumer.seek(TopicPartition(message.topic(), message.partition(), message.offset()))
        self.stop.wait(self.delay)
        self.delay = min(self.delay * 2, 30.0)

    def quarantine(self, message, reason: str) -> None:
        # Reference only (no payload copy, no personal data) for manual recovery.
        if self.producer is None:
            self.producer = self.producer_factory({
                "bootstrap.servers": settings.kafka_brokers,
                "enable.idempotence": True,
                "acks": "all",
                "delivery.timeout.ms": 5000,
            })
        result = []
        self.producer.produce(
            settings.certificates_dlq_topic,
            key=f"{message.topic()}:{message.partition()}",
            value=json.dumps({
                "source_topic": message.topic(),
                "partition": message.partition(),
                "offset": message.offset(),
                "reason": reason,
            }).encode(),
            on_delivery=lambda error, delivered: result.append(error),
        )
        pending = self.producer.flush(6)
        if pending or not result or result[0] is not None:
            raise RuntimeError("Kafka did not confirm the delivery")
