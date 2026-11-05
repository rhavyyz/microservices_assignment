"""A 002 remove a tabela de chaves de idempotência; a 003 remove tentativas de pagamento e lembra o evento pai."""


def test_abandoned_tables_dropped_and_parent_event_column_added(db):
    with db.transaction() as conn:
        tables = {
            r["tablename"]
            for r in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname=current_schema()").fetchall()
        }
        applied = [r["version"] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
        column = conn.execute(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() "
            "AND table_name='registrations' AND column_name='parent_event_id'"
        ).fetchone()
    assert not {"idempotency_keys", "payment_attempts"} & tables
    assert {"registrations", "activity_inventory", "outbox"} <= tables
    assert column == {"is_nullable": "YES"}
    assert applied == ["001_initial.sql", "002_drop_idempotency_keys.sql", "003_declarative_payments.sql"]


def test_migration_003_is_idempotent(db):
    from pathlib import Path

    import app.db

    sql = (Path(app.db.__file__).parent / "migrations" / "003_declarative_payments.sql").read_text(encoding="utf-8")
    with db.transaction() as conn:
        conn.execute(sql)
