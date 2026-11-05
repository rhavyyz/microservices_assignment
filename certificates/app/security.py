"""Identity from trusted headers: the gateway verifies the JWT and injects X-User-Id / X-User-Roles."""

from uuid import UUID

from fastapi import Request

from app.errors import ApiError


def current_user_id(request: Request) -> UUID:
    # Read from the Request (not Header()) to keep the identity header out of the OpenAPI document.
    # A single code: never reveal which check failed.
    try:
        return UUID(request.headers.get("X-User-Id", "").strip())
    except ValueError:
        raise ApiError(401, "UNAUTHENTICATED") from None
