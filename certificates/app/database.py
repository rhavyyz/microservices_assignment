from functools import lru_cache

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


class Base(DeclarativeBase):
    pass


class DatabaseConfigurationError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _create_engine(database_url: str) -> Engine:
    return create_engine(database_url, pool_pre_ping=True)


def check_database_connection() -> None:
    if not settings.database_url:
        raise DatabaseConfigurationError("DATABASE_URL is required")

    with _create_engine(settings.database_url).connect() as connection:
        connection.execute(text("SELECT 1"))
