import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text

from app import migrate

ROOT = Path(__file__).resolve().parents[2]


def run_alembic(db_url, *args):
    # A subprocess: migrations/env.py reads settings at import and reconfigures logging.
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=ROOT,
        env={**os.environ, "DATABASE_URL": db_url, "PYTHONPATH": str(ROOT)},
        capture_output=True,
        text=True,
    )


def test_upgrade_adds_user_and_activity_columns_and_keeps_old_rows(tmp_path):
    # The migrations are portable (sa.Uuid), so SQLite is enough to prove the schema steps; PostgreSQL is not exercised here.
    url = f"sqlite:///{tmp_path / 'certs.db'}"
    assert run_alembic(url, "upgrade", "28706beffa78").returncode == 0
    engine = create_engine(url)
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO certificates (id, registration_id, file_path, issued_at) "
            "VALUES ('a', 'b', 'x.pdf', '2026-01-01 00:00:00')"
        ))

    result = run_alembic(url, "upgrade", "head")

    assert result.returncode == 0, result.stderr
    inspector = inspect(engine)
    columns = {c["name"]: c for c in inspector.get_columns("certificates")}
    assert {"user_id", "activity_id"} <= set(columns)
    assert columns["user_id"]["nullable"] is True
    assert "ix_certificates_user_id" in {i["name"] for i in inspector.get_indexes("certificates")}
    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM certificates")).scalar() == 1

    again = run_alembic(url, "upgrade", "head")  # idempotent
    assert again.returncode == 0

    assert run_alembic(url, "downgrade", "28706beffa78").returncode == 0
    assert "user_id" not in {c["name"] for c in inspect(engine).get_columns("certificates")}
    engine.dispose()


def test_event_id_revision_adds_nullable_column_and_unique_user_event_index(tmp_path):
    url = f"sqlite:///{tmp_path / 'certs.db'}"
    assert run_alembic(url, "upgrade", "7c1d3e9a4b52").returncode == 0
    engine = create_engine(url)
    with engine.begin() as connection:
        for registration in ("r1", "r2"):  # two old rows of the same user: NULL event_id never collides
            connection.execute(text(
                "INSERT INTO certificates (id, registration_id, user_id, file_path, issued_at) "
                f"VALUES ('{registration}', '{registration}', 'u', 'x.pdf', '2026-01-01 00:00:00')"
            ))

    result = run_alembic(url, "upgrade", "head")

    assert result.returncode == 0, result.stderr
    inspector = inspect(engine)
    columns = {c["name"]: c for c in inspector.get_columns("certificates")}
    assert columns["event_id"]["nullable"] is True
    indexes = {i["name"]: i for i in inspector.get_indexes("certificates")}
    assert indexes["uq_certificates_user_event"]["unique"]
    assert indexes["uq_certificates_user_event"]["column_names"] == ["user_id", "event_id"]
    with engine.begin() as connection:
        assert connection.execute(text("SELECT count(*) FROM certificates")).scalar() == 2
        connection.execute(text(
            "INSERT INTO certificates (id, registration_id, user_id, event_id, file_path, issued_at) "
            "VALUES ('a', 'a', 'u', 'e', 'x.pdf', '2026-01-01 00:00:00')"
        ))
    with pytest.raises(Exception), engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO certificates (id, registration_id, user_id, event_id, file_path, issued_at) "
            "VALUES ('b', 'b', 'u', 'e', 'x.pdf', '2026-01-01 00:00:00')"
        ))

    assert run_alembic(url, "downgrade", "7c1d3e9a4b52").returncode == 0
    inspector = inspect(engine)
    assert "event_id" not in {c["name"] for c in inspector.get_columns("certificates")}
    assert "uq_certificates_user_event" not in {i["name"] for i in inspector.get_indexes("certificates")}
    engine.dispose()


def test_single_head():
    result = run_alembic("sqlite://", "heads")

    assert result.returncode == 0
    assert result.stdout.count("(head)") == 1
    assert "b3f5a7d9c1e2" in result.stdout


def test_pending_attendance_revision_creates_table_with_registration_primary_key(tmp_path):
    url = f"sqlite:///{tmp_path / 'certs.db'}"
    assert run_alembic(url, "upgrade", "9e4a6b2c1d83").returncode == 0
    engine = create_engine(url)
    assert "pending_attendance" not in inspect(engine).get_table_names()

    result = run_alembic(url, "upgrade", "head")

    assert result.returncode == 0, result.stderr
    inspector = inspect(engine)
    columns = {c["name"]: c for c in inspector.get_columns("pending_attendance")}
    assert set(columns) == {
        "registration_id", "payload", "not_before", "attempts",
        "source_topic", "source_partition", "source_offset", "created_at",
    }
    assert all(not c["nullable"] for c in columns.values())
    assert inspector.get_pk_constraint("pending_attendance")["constrained_columns"] == ["registration_id"]
    assert "ix_pending_attendance_not_before" in {i["name"] for i in inspector.get_indexes("pending_attendance")}
    with engine.begin() as connection:  # attempts defaults to 0 at the database level
        connection.execute(text(
            "INSERT INTO pending_attendance (registration_id, payload, not_before, source_topic, source_partition, "
            "source_offset, created_at) VALUES ('a', '{}', '2026-01-01 00:00:00', 't', 0, 1, '2026-01-01 00:00:00')"
        ))
        assert connection.execute(text("SELECT attempts FROM pending_attendance")).scalar() == 0
    with pytest.raises(Exception), engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO pending_attendance (registration_id, payload, not_before, source_topic, source_partition, "
            "source_offset, created_at) VALUES ('a', '{}', '2026-01-01 00:00:00', 't', 0, 2, '2026-01-01 00:00:00')"
        ))

    assert run_alembic(url, "downgrade", "9e4a6b2c1d83").returncode == 0
    assert "pending_attendance" not in inspect(engine).get_table_names()
    engine.dispose()


def test_migrate_retries_with_backoff_then_succeeds(monkeypatch):
    attempts, sleeps = [], []

    def flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise RuntimeError("postgresql://user:secret@db/x unreachable")

    monkeypatch.setattr(migrate, "upgrade_head", flaky)
    monkeypatch.setattr(migrate, "_sleep", sleeps.append)

    migrate.migrate()

    assert len(attempts) == 3
    assert sleeps == [1.0, 2.0]


def test_migrate_fails_loudly_after_the_last_attempt(monkeypatch, caplog):
    sleeps = []
    monkeypatch.setattr(migrate, "upgrade_head", lambda: (_ for _ in ()).throw(RuntimeError("secret")))
    monkeypatch.setattr(migrate, "_sleep", sleeps.append)

    with pytest.raises(RuntimeError):
        migrate.migrate(attempts=4)

    assert len(sleeps) == 3
    assert "secret" not in caplog.text


def test_main_returns_non_zero_on_failure(monkeypatch):
    monkeypatch.setattr(migrate, "migrate", lambda: (_ for _ in ()).throw(RuntimeError("x")))

    assert migrate.main() == 1
