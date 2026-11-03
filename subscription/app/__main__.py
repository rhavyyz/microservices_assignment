"""Entrada: python -m app. Migrações: python -m app migrate."""

import logging
import os
import sys

import uvicorn

from .config import Settings
from .db import Database

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
if len(sys.argv) > 1 and sys.argv[1] == "migrate":
    db = Database(Settings.from_env().database_url)
    db.open()
    try:
        db.migrate()
    finally:
        db.close()
else:
    uvicorn.run("app.api:create_app", factory=True, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
