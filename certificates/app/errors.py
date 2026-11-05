"""Uniform application/problem+json errors and X-Trace-Id handling."""

import logging
import re
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError

from app.database import DatabaseConfigurationError
from app.services.storage import CertificateStorageError

log = logging.getLogger(__name__)


class ApiError(Exception):
    """A safe error for the API: only a status and a stable code reach the client."""

    def __init__(self, status: int, code: str) -> None:
        self.status, self.code = status, code
        super().__init__(code)


class Problem(BaseModel):
    status: int
    title: str
    code: str
    traceId: str | None = None


def problem_response(request: Request, status: int, code: str) -> JSONResponse:
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


def problem_docs(*statuses: int) -> dict:
    """OpenAPI `responses` entries for the problem+json errors a route can return."""
    descriptions = {
        400: "Invalid request parameters",
        401: "Missing or invalid X-User-Id (UNAUTHENTICATED)",
        404: "Certificate not found, or not owned by the caller (NOT_FOUND)",
        503: "A dependency (database or file storage) is unavailable",
    }
    schema = Problem.model_json_schema()
    return {
        status: {
            "description": descriptions[status],
            "content": {"application/problem+json": {"schema": schema}},
        }
        for status in statuses
    }


def install_error_handling(app: FastAPI) -> None:
    @app.middleware("http")
    async def trace_id_middleware(request: Request, call_next):
        supplied = request.headers.get("X-Trace-Id", "")
        request.state.trace_id = supplied if re.fullmatch(r"[A-Za-z0-9._-]{8,64}", supplied) else str(uuid4())
        response = await call_next(request)
        response.headers["X-Trace-Id"] = request.state.trace_id
        return response

    @app.exception_handler(ApiError)
    async def api_error(request: Request, exc: ApiError):
        return problem_response(request, exc.status, exc.code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        return problem_response(request, 400, "INVALID_REQUEST")

    @app.exception_handler(SQLAlchemyError)
    @app.exception_handler(DatabaseConfigurationError)
    async def database_error(request: Request, exc: Exception):
        log.error("database_operation_failed trace_id=%s", request.state.trace_id)
        return problem_response(request, 503, "DATABASE_UNAVAILABLE")

    @app.exception_handler(CertificateStorageError)
    async def storage_error(request: Request, exc: CertificateStorageError):
        log.error("storage_operation_failed trace_id=%s", request.state.trace_id)
        return problem_response(request, 503, "STORAGE_UNAVAILABLE")
