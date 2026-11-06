"""Issues the certificates of messages parked because their event had not ended (see AttendanceHandler.park).

A daemon thread wakes up every INTERVAL seconds and works through the due rows in small batches, with the
same issuing logic as the Kafka consumer (AttendanceHandler.process). Several replicas can run it: on
PostgreSQL the batch is selected with FOR UPDATE SKIP LOCKED. A failing dependency delays only its own row.
"""

import logging
import threading
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.consumer import AttendanceHandler, DeadLetters, EventNotEnded, exc_trace_id
from app.database import get_session_factory
from app.integrations.directory import PoisonMessage, TransientError
from app.models.pending_attendance import PendingAttendance

log = logging.getLogger(__name__)

INTERVAL = 30.0
BATCH_SIZE = 10
RESCHEDULE_AFTER_EARLY = timedelta(seconds=60)
BACKOFF_BASE = 30
BACKOFF_MAX = timedelta(minutes=15)


def backoff(attempts: int) -> timedelta:
    return min(timedelta(seconds=BACKOFF_BASE * 2 ** min(attempts, 16)), BACKOFF_MAX)


class PendingScheduler:
    def __init__(
        self,
        handler: AttendanceHandler | None = None,
        session_factory: Callable | None = None,
        dead_letters: DeadLetters | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        interval: float = INTERVAL,
    ) -> None:
        self.handler = handler or AttendanceHandler()
        self.session_factory = session_factory or (lambda: get_session_factory()())
        self.dead_letters = dead_letters or DeadLetters()
        self.clock = clock
        self.interval = interval
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        self.thread = threading.Thread(target=self.run, name="pending-attendance", daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=15)

    def run(self) -> None:
        while not self.stop.is_set():
            try:
                self.drain()
            except Exception as exc:
                log.warning("pending_scheduler_failed cause=%s", type(exc).__name__)
            self.stop.wait(self.interval)

    def drain(self) -> int:
        """Process batches until no due row is left; returns how many rows were handled."""
        total = 0
        while not self.stop.is_set():
            handled = self.tick()
            total += handled
            if handled < BATCH_SIZE:
                break
        return total

    def tick(self) -> int:
        """Process one batch of due rows. Rows that are kept get a later not_before, so they are not selected again."""
        session = self.session_factory()
        try:
            now = self.clock()
            query = (
                select(PendingAttendance)
                .where(PendingAttendance.not_before <= now)
                .order_by(PendingAttendance.not_before)
                .limit(BATCH_SIZE)
            )
            if session.get_bind().dialect.name == "postgresql":
                query = query.with_for_update(skip_locked=True)
            rows = list(session.scalars(query))
            for row in rows:
                self.handle_row(session, row, now)
            session.commit()
            return len(rows)
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def handle_row(self, session, row: PendingAttendance, now: datetime) -> None:
        registration_id = row.registration_id
        try:
            trace_id = self.handler.process(row.payload)
        except EventNotEnded as early:
            # Clock skew, or Events moved the end later: look again when the event now ends (at least a minute away).
            row.not_before = max(early.ends_at.astimezone(timezone.utc), now + RESCHEDULE_AFTER_EARLY)
            log.info("attendance_still_early registration_id=%s trace_id=%s", registration_id, exc_trace_id(early))
        except PoisonMessage as exc:
            try:
                self.dead_letters.publish(
                    row.source_topic, row.source_partition, row.source_offset, exc.reason, getattr(exc, "trace_id", None),
                )
            except Exception:
                log.warning("dlq_publish_failed registration_id=%s trace_id=%s", registration_id, exc_trace_id(exc))
                self.keep(row, now)
                return
            log.warning("poison_parked_message registration_id=%s reason=%s trace_id=%s",
                        registration_id, exc.reason, exc_trace_id(exc))
            session.delete(row)
        except TransientError as exc:
            log.warning("pending_transient_failure registration_id=%s cause=%s trace_id=%s",
                        registration_id, exc, exc_trace_id(exc))
            self.keep(row, now)
        except Exception as exc:
            log.warning("pending_unexpected_failure registration_id=%s cause=%s trace_id=%s",
                        registration_id, type(exc).__name__, exc_trace_id(exc))
            self.keep(row, now)
        else:
            log.info("attendance_unparked registration_id=%s trace_id=%s", registration_id, trace_id)
            session.delete(row)

    @staticmethod
    def keep(row: PendingAttendance, now: datetime) -> None:
        row.attempts += 1
        row.not_before = now + backoff(row.attempts)
