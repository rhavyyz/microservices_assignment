"""Forma textual única dos valores JSON de mensagens Kafka e do outbox."""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID


def json_default(value):
    """`default` de json.dumps: datas em ISO 8601 (com offset quando existir)."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (UUID, Decimal)):
        return str(value)
    return str(value)
