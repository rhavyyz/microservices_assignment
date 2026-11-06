import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, BigInteger, DateTime, Integer, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PendingAttendance(Base):
    """An `AttendanceEligible` message that arrived before its event ended, parked until `not_before`.

    The Kafka offset is committed once the row exists, so an early message never blocks the partition.
    """

    __tablename__ = "pending_attendance"

    # One row per registration: parking the same message again is a no-op.
    registration_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)

    # The validated message (identifiers and attendance counts only), replayed through the consumer's logic.
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)

    # The event's ends_at at the time of parking; moved later when the event turns out to end later.
    not_before: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    # Where the message came from: a poison parked message goes to the DLQ with the same reference record.
    source_topic: Mapped[str] = mapped_column(String(255), nullable=False)
    source_partition: Mapped[int] = mapped_column(Integer, nullable=False)
    source_offset: Mapped[int] = mapped_column(BigInteger, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
