
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Certificate(Base):
    __tablename__ = "certificates"
    # One certificate per participant and event. Rows without event_id (issued before the column existed)
    # never collide: NULLs are distinct in a unique index.
    __table_args__ = (Index("uq_certificates_user_event", "user_id", "event_id", unique=True),)

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )

    registration_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
        unique=True,
        index=True,
    )

    # Nullable only because rows created before these columns existed cannot be backfilled
    # (the original registration was never stored). Every new certificate sets both:
    # CertificateRepository.create requires them, and rows without user_id are never served.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
        index=True,
    )

    activity_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
    )

    # Nullable for the same reason as user_id/activity_id: certificates issued per activity before this column
    # existed cannot be backfilled. Every new certificate sets it (CertificateRepository.create requires it).
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
    )

    file_path: Mapped[str] = mapped_column(
        String(1024),
        nullable=False,
    )

    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
