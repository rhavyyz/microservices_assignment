"""Transações PostgreSQL e migrações versionadas, serializadas entre réplicas."""

from contextlib import contextmanager
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


class Database:
    def __init__(self, url):
        self.pool = ConnectionPool(
            url,
            min_size=1,
            max_size=12,
            open=False,
            kwargs={"row_factory": dict_row, "autocommit": True},
            timeout=5,
        )

    def open(self):
        self.pool.open(wait=True, timeout=15)

    def close(self):
        self.pool.close()

    @contextmanager
    def transaction(self):
        # O contexto confirma no sucesso e desfaz tudo quando ocorre uma exceção.
        with self.pool.connection() as conn, conn.transaction():
            yield conn

    def migrate(self):
        with self.transaction() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(731906421)")
            conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY)")
            for path in sorted((Path(__file__).parent / "migrations").glob("*.sql")):
                if not conn.execute(
                    "SELECT 1 FROM schema_migrations WHERE version=%s", (path.name,)
                ).fetchone():
                    conn.execute(path.read_text(encoding="utf-8"))
                    conn.execute("INSERT INTO schema_migrations VALUES (%s)", (path.name,))
