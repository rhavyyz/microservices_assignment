"""Run `alembic upgrade head` before the server starts: `python -m app.migrate`.

Idempotent (an up-to-date database is a no-op). Retries with a growing delay while the
database is unreachable and exits non-zero when it still fails, so the container
restarts loudly instead of serving against a missing schema.
"""

import logging
import sys
import time
from pathlib import Path

from alembic import command
from alembic.config import Config

log = logging.getLogger("app.migrate")

ATTEMPTS = 10
INITIAL_DELAY = 1.0
MAX_DELAY = 15.0

_sleep = time.sleep  # replaced in tests


def upgrade_head() -> None:
    config = Config(str(Path(__file__).resolve().parent.parent / "alembic.ini"))
    config.set_main_option(
        "script_location", str(Path(__file__).resolve().parent.parent / "migrations")
    )
    command.upgrade(config, "head")


def migrate(attempts: int = ATTEMPTS) -> None:
    delay = INITIAL_DELAY
    for attempt in range(1, attempts + 1):
        try:
            upgrade_head()
            log.info("migrations_applied")
            return
        except Exception as exc:
            # Only the exception type: the message may carry the database URL.
            log.warning("migration_failed attempt=%d/%d error=%s", attempt, attempts, type(exc).__name__)
            if attempt == attempts:
                raise
            _sleep(delay)
            delay = min(delay * 2, MAX_DELAY)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    try:
        migrate()
    except Exception:
        log.error("migrations_could_not_be_applied")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
