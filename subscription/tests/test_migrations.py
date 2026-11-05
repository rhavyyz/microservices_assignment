"""A 002 remove a tabela de chaves de idempotência abandonada; a 003 cria a de emissões por evento;
a 004 remove tentativas de pagamento e lembra o evento; a 005 renomeia inbox.event_id para message_id;
a 006 renomeia registrations.parent_event_id para event_id."""

import psycopg
import pytest


def test_abandoned_tables_dropped_and_event_column_added(db):
    with db.transaction() as conn:
        tables = {
            r["tablename"]
            for r in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname=current_schema()").fetchall()
        }
        applied = [r["version"] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
        column = conn.execute(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() "
            "AND table_name='registrations' AND column_name='event_id'"
        ).fetchone()
        old_column = conn.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() "
            "AND table_name='registrations' AND column_name='parent_event_id'"
        ).fetchone()
    assert not {"idempotency_keys", "payment_attempts"} & tables
    assert {"registrations", "activity_inventory", "outbox"} <= tables
    assert column == {"is_nullable": "YES"} and old_column is None
    assert applied == [
        "001_initial.sql",
        "002_drop_idempotency_keys.sql",
        "003_event_attendance_emitted.sql",
        "004_declarative_payments.sql",
        "005_inbox_message_id.sql",
        "006_registration_event_id.sql",
    ]


def test_migration_004_is_idempotent(db):
    from pathlib import Path

    import app.db

    sql = (Path(app.db.__file__).parent / "migrations" / "004_declarative_payments.sql").read_text(encoding="utf-8")
    with db.transaction() as conn:
        conn.execute(sql)


def test_inbox_column_renamed_to_message_id_keeping_primary_key(db):
    with db.transaction() as conn:
        cols = {
            r["column_name"]
            for r in conn.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema=current_schema() AND table_name='inbox'"
            ).fetchall()
        }
        pk = {
            r["attname"]
            for r in conn.execute(
                "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) "
                "WHERE i.indrelid='inbox'::regclass AND i.indisprimary"
            ).fetchall()
        }
    assert "message_id" in cols and "event_id" not in cols
    assert pk == {"source", "message_id"}


def test_migration_005_is_idempotent(db):
    from pathlib import Path

    import app.db

    sql = (Path(app.db.__file__).parent / "migrations" / "005_inbox_message_id.sql").read_text(encoding="utf-8")
    with db.transaction() as conn:
        conn.execute(sql)


def test_registrations_event_id_is_nullable_uuid(db):
    with db.transaction() as conn:
        column = conn.execute(
            "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema=current_schema() "
            "AND table_name='registrations' AND column_name='event_id'"
        ).fetchone()
    assert column == {"data_type": "uuid", "is_nullable": "YES"}


def test_migration_006_is_idempotent(db):
    from pathlib import Path

    import app.db

    sql = (Path(app.db.__file__).parent / "migrations" / "006_registration_event_id.sql").read_text(encoding="utf-8")
    with db.transaction() as conn:
        conn.execute(sql)


def test_event_attendance_emitted_table(db):
    user, event = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
    with db.transaction() as conn:
        cols = {
            r["column_name"]: r
            for r in conn.execute(
                "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
                "WHERE table_schema=current_schema() AND table_name='event_attendance_emitted'"
            ).fetchall()
        }
        # A coluna antiga permanece (sem alteração destrutiva), mas fica sem uso.
        legacy = conn.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() "
            "AND table_name='attendance' AND column_name='eligible_emitted'"
        ).fetchone()
        conn.execute("INSERT INTO event_attendance_emitted(user_id,event_id) VALUES (%s,%s)", (user, event))
        emitted_at = conn.execute("SELECT emitted_at FROM event_attendance_emitted").fetchone()["emitted_at"]
    assert set(cols) == {"user_id", "event_id", "emitted_at"}
    assert cols["user_id"]["data_type"] == cols["event_id"]["data_type"] == "uuid"
    assert all(c["is_nullable"] == "NO" for c in cols.values())
    assert emitted_at is not None and legacy
    with pytest.raises(psycopg.errors.UniqueViolation):
        with db.transaction() as conn:
            conn.execute("INSERT INTO event_attendance_emitted(user_id,event_id) VALUES (%s,%s)", (user, event))
