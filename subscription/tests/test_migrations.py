"""A migração 002 remove a tabela de chaves de idempotência abandonada."""


def test_idempotency_keys_table_dropped(db):
    with db.transaction() as conn:
        tables = {
            r["tablename"]
            for r in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname=current_schema()").fetchall()
        }
        applied = [r["version"] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
    assert "idempotency_keys" not in tables
    assert {"registrations", "activity_inventory", "payment_attempts", "outbox"} <= tables
    assert applied == ["001_initial.sql", "002_drop_idempotency_keys.sql"]
