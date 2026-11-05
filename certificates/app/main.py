import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes.certificates import router
from app.config import settings
from app.errors import install_error_handling
from app.runtime import Runtime

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Migrations run before the server starts (python -m app.migrate in the image command).
    # Everything below runs in daemon threads: the service boots and serves /healthcheck even if
    # Kafka, the discoverer or the object store are down.
    runtime = Runtime() if settings.workers_enabled else None
    if runtime is not None:
        runtime.start()
    try:
        yield
    finally:
        if runtime is not None:
            runtime.close()


app = FastAPI(
    title="Certificates Service",
    version="0.1.0",
    lifespan=lifespan,
    openapi_url="/openapi.json",
    docs_url=None,
    redoc_url=None,
)
install_error_handling(app)
app.include_router(router)
