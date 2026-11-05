"""API pública: identidade pelos cabeçalhos do gateway, autorização por recurso e OpenAPI para o gateway."""

import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Query, Request, Response
from fastapi.responses import JSONResponse
from psycopg import Error as DatabaseError
from psycopg_pool import PoolTimeout
from pydantic import BaseModel, ConfigDict

from .config import Settings
from .contracts import DomainError
from .db import Database
from .integrations import Services
from .security import Authenticator
from .service import SubscriptionService
from .workers import Workers

log = logging.getLogger(__name__)


class CreateRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    join_waitlist: bool = True


class InternalRegistration(BaseModel):
    """Fatos da inscrição lidos por Pagamentos; sem identidade nem dados de contato."""

    registration_id: UUID
    user_id: UUID
    status: str
    amount_minor: int
    currency: str
    expires_at: datetime | None
    parent_event_id: UUID | None


def create_app(settings=None, database=None, services=None, authenticator=None):
    settings = settings or Settings.from_env()
    db = database or Database(settings.database_url)
    external = services or Services(settings)
    service = SubscriptionService(db, settings)
    auth = authenticator or Authenticator(settings)
    workers = Workers(db, service, external, settings)

    @asynccontextmanager
    async def lifespan(app):
        db.open()
        db.migrate()
        if settings.workers_enabled:
            workers.start()
        try:
            yield
        finally:
            workers.close()
            external.close()
            db.close()

    app = FastAPI(
        title="EventHub — Inscrições",
        version="0.1.0",
        lifespan=lifespan,
        openapi_url="/openapi.json",
        docs_url=None,
        redoc_url=None,
    )
    app.state.service = service

    @app.middleware("http")
    async def request_id(request: Request, call_next):
        supplied = request.headers.get("X-Request-Id", "")
        request.state.trace_id = supplied if re.fullmatch(r"[A-Za-z0-9._-]{8,64}", supplied) else str(uuid4())
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.trace_id
        return response

    def problem(request, status, code):
        return JSONResponse(
            status_code=status,
            media_type="application/problem+json",
            content={
                "status": status,
                "title": code,
                "code": code,
                "traceId": getattr(request.state, "trace_id", None),
            },
        )

    @app.exception_handler(DomainError)
    async def business_error(request, exc):
        return problem(request, exc.status, exc.code)

    @app.exception_handler(DatabaseError)
    @app.exception_handler(PoolTimeout)
    async def database_error(request, exc):
        log.error("database_operation_failed", extra={"trace_id": request.state.trace_id})
        return problem(request, 503, "DATABASE_UNAVAILABLE")

    def principal(request: Request):
        # Lido do Request (não de Header()) para manter a identidade fora do OpenAPI.
        return auth.authenticate(request.headers)

    def outbound(request, who):
        return {**who.identity_headers(), "X-Request-Id": request.state.trace_id}

    def organizer(activity_id, request, who):
        if "ORGANIZER" not in who.roles:
            raise DomainError(403, "FORBIDDEN")
        external.authorize_organizer(activity_id, outbound(request, who))

    @app.get("/healthcheck")
    def healthcheck():
        with db.transaction() as conn:
            conn.execute("SELECT 1")
        return {"status": "UP"}

    # Rota interna (isolamento de rede, sem autenticação): fora do OpenAPI e do register_gateway.
    @app.get(
        "/internal/registrations/{registration_id}", response_model=InternalRegistration, include_in_schema=False
    )
    def internal_registration(registration_id: str):
        try:
            parsed = UUID(registration_id)
        except ValueError:
            raise DomainError(404, "REGISTRATION_NOT_FOUND") from None
        return service.internal_registration(parsed)

    @app.post("/api/v1/activities/{activity_id}/registrations", status_code=201)
    def create(
        activity_id: UUID,
        body: CreateRegistration,
        request: Request,
        response: Response,
        who=Depends(principal),
    ):
        # Idempotente por (pessoa, atividade): repetir devolve a inscrição viva, sem consultar Eventos.
        existing = service.active_registration(who.user_id, activity_id)
        if existing is not None:
            response.status_code = 200
            return existing
        activity = external.activity(activity_id, outbound(request, who))
        return service.create(who.user_id, activity, body.join_waitlist, request.state.trace_id)

    @app.get("/api/v1/activities/{activity_id}/availability")
    def availability(activity_id: UUID, request: Request, who=Depends(principal)):
        return service.availability(external.activity(activity_id, outbound(request, who)))

    # Rotas literais precisam preceder o parâmetro {registration_id}.
    @app.get("/api/v1/registrations/me")
    def mine(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), who=Depends(principal)):
        return {"registrations": service.list(user_id=who.user_id, limit=limit, offset=offset)}

    @app.get("/api/v1/registrations/{registration_id}")
    def get(registration_id: UUID, who=Depends(principal)):
        return service.get(registration_id, who.user_id)

    @app.post("/api/v1/registrations/{registration_id}/cancel")
    def cancel(registration_id: UUID, request: Request, who=Depends(principal)):
        return service.cancel(registration_id, who.user_id, request.state.trace_id)

    @app.post("/api/v1/registrations/{registration_id}/accept-offer")
    def accept(registration_id: UUID, request: Request, who=Depends(principal)):
        reg = service.get(registration_id, who.user_id)
        return service.accept(
            registration_id,
            who.user_id,
            external.activity(reg["activity_id"], outbound(request, who)),
            request.state.trace_id,
        )

    @app.get("/api/v1/activities/{activity_id}/registrations")
    def participants(
        activity_id: UUID,
        request: Request,
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0),
        who=Depends(principal),
    ):
        organizer(activity_id, request, who)
        return {"registrations": service.list(activity_id=activity_id, limit=limit, offset=offset)}

    @app.post("/api/v1/registrations/{registration_id}/check-in")
    def check_in(registration_id: UUID, request: Request, who=Depends(principal)):
        if "ORGANIZER" not in who.roles:
            raise DomainError(403, "FORBIDDEN")
        reg = service.get(registration_id)
        organizer(reg["activity_id"], request, who)
        return service.check_in(
            registration_id,
            who.user_id,
            external.activity(reg["activity_id"], outbound(request, who)),
            request.state.trace_id,
        )

    return app
