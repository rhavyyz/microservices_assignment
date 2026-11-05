"""add user_id and activity_id to certificates

Revision ID: 7c1d3e9a4b52
Revises: 28706beffa78
Create Date: 2026-11-04 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7c1d3e9a4b52'
down_revision: Union[str, None] = '28706beffa78'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # The columns are nullable on purpose: rows that already exist cannot be backfilled (the user and activity
    # of an old registration were never stored), and a NOT NULL column with a fake default would attribute
    # those certificates to a nonexistent user. Every certificate issued from now on sets both values
    # (CertificateRepository.create requires them); rows with a NULL user_id belong to nobody and are never served.
    op.add_column('certificates', sa.Column('user_id', sa.Uuid(), nullable=True))
    op.add_column('certificates', sa.Column('activity_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_certificates_user_id'), 'certificates', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_certificates_user_id'), table_name='certificates')
    op.drop_column('certificates', 'activity_id')
    op.drop_column('certificates', 'user_id')
