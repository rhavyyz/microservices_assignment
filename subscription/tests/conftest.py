"""Banco PostgreSQL real, com um schema descartável por teste; nunca usar banco de produção."""

import os
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

from app.config import Settings
from app.db import Database
from app.service import SubscriptionService


@pytest.fixture
def db():
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Defina TEST_DATABASE_URL para executar com PostgreSQL real")
    schema = "test_" + uuid4().hex
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    database = Database(make_conninfo(url, options=f"-c search_path={schema}"))
    database.open()
    database.migrate()
    yield database
    database.close()
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture
def settings():
    return Settings(database_url="unused", workers_enabled=False)


@pytest.fixture
def service(db, settings):
    return SubscriptionService(db, settings)
