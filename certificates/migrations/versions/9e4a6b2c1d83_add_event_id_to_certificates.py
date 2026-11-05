"""add event_id to certificates, one certificate per user and event

Revision ID: 9e4a6b2c1d83
Revises: 7c1d3e9a4b52
Create Date: 2026-11-05 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9e4a6b2c1d83'
down_revision: Union[str, None] = '7c1d3e9a4b52'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Nullable on purpose, like user_id/activity_id: certificates issued per activity before this revision
    # cannot be backfilled (the event of their activity was never stored). Every certificate issued from now on
    # sets it. The unique index tolerates those rows: NULLs are distinct in PostgreSQL and SQLite.
    op.add_column('certificates', sa.Column('event_id', sa.Uuid(), nullable=True))
    op.create_index('uq_certificates_user_event', 'certificates', ['user_id', 'event_id'], unique=True)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('uq_certificates_user_event', table_name='certificates')
    op.drop_column('certificates', 'event_id')
