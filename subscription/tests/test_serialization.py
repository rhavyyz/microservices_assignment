"""Forma textual de datas e tipos especiais nas mensagens Kafka."""

import json
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from app.serialization import json_default
from app.workers import Workers


def test_aware_datetime_with_microseconds_is_iso():
    value = datetime(2026, 11, 4, 12, 0, 0, 123456, tzinfo=UTC)
    assert json_default(value) == "2026-11-04T12:00:00.123456+00:00"


def test_offset_is_kept_and_naive_gets_none():
    assert json_default(datetime(2026, 11, 4, 9, tzinfo=timezone(timedelta(hours=-3)))).endswith("-03:00")
    assert json_default(datetime(2026, 11, 4, 9)) == "2026-11-04T09:00:00"


def test_other_types():
    assert json_default(date(2026, 11, 4)) == "2026-11-04"
    uid = UUID("11111111-1111-4111-8111-111111111111")
    assert json_default(uid) == str(uid)
    assert json_default(Decimal("10.50")) == "10.50"
    assert json_default(object).startswith("<class")


def test_deliver_emits_iso_occurred_at():
    sent = {}

    class Producer:
        def produce(self, topic, key, value, on_delivery):
            sent["value"] = value
            on_delivery(None, None)

        def flush(self, timeout):
            return 0

    payload = {
        "message_id": UUID("22222222-2222-4222-8222-222222222222"),
        "occurred_at": datetime(2026, 11, 4, 12, 0, 0, 123456, tzinfo=UTC),
    }
    Workers.deliver(Producer(), "t", "k", payload)
    body = json.loads(sent["value"])
    assert set(body) == set(payload)
    assert body["occurred_at"] == "2026-11-04T12:00:00.123456+00:00"
    assert datetime.fromisoformat(body["occurred_at"]) == payload["occurred_at"]
