"""Certificates are created only here, from Subscription's `AttendanceEligible` events (DT-06).

Delivery is at least once: the offset is committed after processing, and a redelivered event is a
no-op because a certificate is unique per registration and per (user, event). The event is not trusted
on its own; see AttendanceHandler.

A message that arrives before its event has ended is parked in the service's own database (PendingAttendance)
and its offset is committed, so it never blocks the partition; app/pending.py issues it once the event ends.
"""

import json
import logging
import math
import re
import threading
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from typing import NamedTuple

from confluent_kafka import Consumer, Producer, TopicPartition
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.database import get_session_factory
from app.integrations.directory import Directory, PoisonMessage, TransientError
from app.integrations.topics import ensure_topics
from app.models.pending_attendance import PendingAttendance
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


TRACE_ID_PATTERN = re.compile(r"[A-Za-z0-9._-]{8,64}")


def valid_trace_id(value: object) -> str | None:
    """The platform's trace id rule, applied to optional metadata: anything else is None, never an error."""
    return value if isinstance(value, str) and TRACE_ID_PATTERN.fullmatch(value) else None


def resolve_trace_id(payload: dict) -> str:
    """The message's trace_id when it is valid, otherwise a new one (the message may come from background work)."""
    return valid_trace_id(payload.get("trace_id")) or str(uuid.uuid4())


def exc_trace_id(exc: BaseException) -> str:
    """The trace id process() tagged on a failure, for log lines; "-" when the failure happened before one existed."""
    return getattr(exc, "trace_id", None) or "-"


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


class EventNotEnded(TransientError):
    """The event's `ends_at` is still in the future. The consumer parks the message; the scheduler reschedules it."""

    def __init__(self, ends_at: datetime) -> None:
        self.ends_at = ends_at
        super().__init__("event has not ended yet")


class Source(NamedTuple):
    """Where a message came from, kept with a parked message so a DLQ record keeps the same shape."""

    topic: str
    partition: int
    offset: int


class AttendanceHandler:
    """Turns one raw Kafka message into a certificate, or raises PoisonMessage / TransientError.

    A message for an event that has not ended is parked instead (see `park`) and handle() returns normally.
    """

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

    def handle(self, raw: bytes | None, source: Source | None = None) -> None:
        try:
            payload = json.loads(raw or b"")
        except (ValueError, UnicodeError):
            raise PoisonMessage("INVALID_JSON") from None
        if not isinstance(payload, dict):
            raise PoisonMessage("INVALID_CONTRACT")

        # Every other type, including types this version does not know, is acknowledged and ignored.
        if payload.get("type") != ELIGIBLE_TYPE:
            return

        try:
            self.process(payload)
        except EventNotEnded as early:
            # Normal case: Subscription emits when the person's last activity ends, possibly days before the event.
            try:
                self.park(payload, early.ends_at, source, exc_trace_id(early))
            except Exception as exc:
                exc.trace_id = exc_trace_id(early)
                raise

    def process(self, payload: dict) -> str:
        """Validate an `AttendanceEligible` payload and issue its certificate (shared by the consumer and the scheduler).

        Returns the trace id used, on success (issued or already issued); raises PoisonMessage, or TransientError
        (EventNotEnded when the event is still running). The trace id is the payload's own when valid (so the
        trace started by the request that caused the event continues here), a new one otherwise; a raised
        error carries it as `trace_id`.
        """
        trace_id = resolve_trace_id(payload)
        try:
            self._process(payload, trace_id)
        except Exception as exc:
            exc.trace_id = trace_id
            raise
        return trace_id

    def _process(self, payload: dict, trace_id: str) -> None:
        if payload.get("schema_version") != SCHEMA_VERSION or isinstance(payload.get("schema_version"), bool):
            raise PoisonMessage("UNSUPPORTED_SCHEMA_VERSION")
        registration_id = _uuid(payload, "registration_id")
        activity_id = _uuid(payload, "activity_id")
        user_id = _uuid(payload, "user_id")
        event_id = _uuid(payload, "event_id")
        _, _, attendance_percentage = _attendance(payload)

        log.info("attendance_eligible_received registration_id=%s trace_id=%s", registration_id, trace_id)

        try:
            self._issue(registration_id, activity_id, user_id, event_id, attendance_percentage, trace_id)
        except (PoisonMessage, TransientError):
            raise
        except CertificateAlreadyExistsError:
            log.info("certificate_already_issued registration_id=%s trace_id=%s", registration_id, trace_id)
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
        trace_id: str,
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
                log.info("certificate_already_issued registration_id=%s trace_id=%s", registration_id, trace_id)
                return

            event = self.directory.get_event(event_id, trace_id)
            if event.status == "CANCELLED":
                raise PoisonMessage("EVENT_CANCELLED")
            if self.clock() < event.ends_at:
                raise EventNotEnded(event.ends_at)

            participant_name = self.directory.get_participant_name(user_id, trace_id)

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
            log.info("certificate_issued registration_id=%s trace_id=%s", registration_id, trace_id)
        finally:
            session.close()


    def park(self, payload: dict, ends_at: datetime, source: Source | None, trace_id: str | None = None) -> None:
        """Keep the message in the database until the event ends. Idempotent per registration.

        The payload is stored whole, so its trace_id comes back when the scheduler replays it; an invalid one is
        dropped here (never stored, never logged).
        """
        payload = {key: value for key, value in payload.items() if key != "trace_id"}
        if trace_id:
            payload["trace_id"] = trace_id
        source = source or Source(settings.subscription_events_topic, -1, -1)
        registration_id = _uuid(payload, "registration_id")
        session = self.session_factory()
        try:
            if session.get(PendingAttendance, registration_id) is None:
                session.add(PendingAttendance(
                    registration_id=registration_id,
                    payload=payload,
                    not_before=ends_at.astimezone(timezone.utc),
                    attempts=0,
                    source_topic=source.topic,
                    source_partition=source.partition,
                    source_offset=source.offset,
                    created_at=self.clock(),
                ))
                try:
                    session.commit()
                except IntegrityError:
                    session.rollback()  # another replica parked it first
            log.info("attendance_parked registration_id=%s trace_id=%s", registration_id, trace_id or "-")
        finally:
            session.close()


class DeadLetters:
    """Publishes reference-only records to the DLQ and waits for Kafka's confirmation."""

    def __init__(self, producer_factory=None) -> None:
        self.producer_factory = producer_factory or Producer
        self.producer = None

    def publish(self, topic: str, partition: int, offset: int, reason: str, trace_id: str | None = None) -> None:
        # Reference only (no payload copy, no personal data) for manual recovery; trace_id only when valid.
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
            key=f"{topic}:{partition}",
            value=json.dumps({
                "source_topic": topic,
                "partition": partition,
                "offset": offset,
                "reason": reason,
                **({"trace_id": trace_id} if valid_trace_id(trace_id) else {}),
            }).encode(),
            on_delivery=lambda error, delivered: result.append(error),
        )
        pending = self.producer.flush(6)
        if pending or not result or result[0] is not None:
            raise RuntimeError("Kafka did not confirm the delivery")


class AttendanceWorker:
    """Daemon-thread Kafka loop: ensure topics, consume, process, commit after processing."""

    def __init__(self, handler=None, consumer_factory=None, producer_factory=None, topics_ensurer=None):
        self.handler = handler or AttendanceHandler()
        # Resolved here, not as default arguments, so they can be replaced in tests.
        self.consumer_factory = consumer_factory or Consumer
        self.producer_factory = producer_factory or Producer
        self.topics_ensurer = topics_ensurer or ensure_topics
        self.dead_letters = DeadLetters(lambda config: self.producer_factory(config))
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None
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
            self.handler.handle(message.value(), Source(message.topic(), message.partition(), message.offset()))
        except PoisonMessage as exc:
            try:
                self.quarantine(message, exc.reason, getattr(exc, "trace_id", None))
            except Exception:
                log.warning("dlq_publish_failed topic=%s partition=%s offset=%s trace_id=%s",
                            message.topic(), message.partition(), message.offset(), exc_trace_id(exc))
                self.retry_later(consumer, message)
                return
            log.warning("poison_message topic=%s partition=%s offset=%s reason=%s trace_id=%s",
                        message.topic(), message.partition(), message.offset(), exc.reason, exc_trace_id(exc))
        except TransientError as exc:
            log.warning("transient_failure topic=%s partition=%s offset=%s cause=%s trace_id=%s",
                        message.topic(), message.partition(), message.offset(), exc, exc_trace_id(exc))
            self.retry_later(consumer, message)
            return
        except Exception as exc:
            log.warning("unexpected_failure topic=%s partition=%s offset=%s cause=%s trace_id=%s",
                        message.topic(), message.partition(), message.offset(), type(exc).__name__, exc_trace_id(exc))
            self.retry_later(consumer, message)
            return

        consumer.commit(message=message, asynchronous=False)
        self.delay = 2.0

    def retry_later(self, consumer, message) -> None:
        # Not committing keeps the offset; seeking back makes the next poll return this same message.
        consumer.seek(TopicPartition(message.topic(), message.partition(), message.offset()))
        self.stop.wait(self.delay)
        self.delay = min(self.delay * 2, 30.0)

    def quarantine(self, message, reason: str, trace_id: str | None = None) -> None:
        self.dead_letters.publish(message.topic(), message.partition(), message.offset(), reason, trace_id)
