"""Validação RS256 independente do X-User-Id não verificado pelo gateway atual."""

import threading
from dataclasses import dataclass
from uuid import UUID

import httpx
import jwt

from .contracts import DomainError


@dataclass(frozen=True)
class Principal:
    user_id: str
    roles: tuple[str, ...]
    bearer: str


class Authenticator:
    def __init__(self, settings, services):
        self.settings, self.services = settings, services
        self.clients = {}
        self.lock = threading.Lock()

    def authenticate(self, authorization):
        if not authorization or not authorization.startswith("Bearer "):
            raise DomainError(401, "INVALID_TOKEN")
        token = authorization[7:]
        try:
            # A URL é configuração confiável ou descoberta, nunca vem do cabeçalho JWT.
            url = self.settings.jwks_url or self.services.resolve("user") + "/.well-known/jwks.json"
            with self.lock:
                client = self.clients.setdefault(url, jwt.PyJWKClient(url, timeout=5, lifespan=300))
            key = client.get_signing_key_from_jwt(token).key
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                issuer=self.settings.jwt_issuer,
                options={"require": ["sub", "exp", "iat", "iss"], "verify_aud": False},
            )
            roles = claims.get("roles", [])
            if not isinstance(roles, list) or not all(isinstance(role, str) for role in roles):
                raise ValueError("roles inválido")
            return Principal(str(UUID(claims["sub"])), tuple(roles), token)
        except (jwt.PyJWKClientConnectionError, httpx.HTTPError) as exc:
            raise DomainError(503, "IDENTITY_UNAVAILABLE") from exc
        except (jwt.PyJWTError, ValueError, KeyError, TypeError) as exc:
            raise DomainError(401, "INVALID_TOKEN") from exc
