"""create pending_attendance table

Revision ID: b3f5a7d9c1e2
Revises: 9e4a6b2c1d83
Create Date: 2026-11-05 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3f5a7d9c1e2'
down_revision: Union[str, None] = '9e4a6b2c1d83'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Messages that arrive before their event ends are parked here (offset committed) until not_before.
    # registration_id as primary key makes parking idempotent.
    op.create_table(
        'pending_attendance',
        sa.Column('registration_id', sa.Uuid(), nullable=False),
        sa.Column('payload', sa.JSON(), nullable=False),
        sa.Column('not_before', sa.DateTime(timezone=True), nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('source_topic', sa.String(length=255), nullable=False),
        sa.Column('source_partition', sa.Integer(), nullable=False),
        sa.Column('source_offset', sa.BigInteger(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('registration_id'),
    )
    op.create_index('ix_pending_attendance_not_before', 'pending_attendance', ['not_before'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_pending_attendance_not_before', table_name='pending_attendance')
    op.drop_table('pending_attendance')
