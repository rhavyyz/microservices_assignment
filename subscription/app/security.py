"""Identidade por cabeçalhos confiáveis: o gateway verifica o JWT e injeta X-User-Id/X-User-Roles."""

from dataclasses import dataclass
from uuid import UUID

from .contracts import DomainError


@dataclass(frozen=True)
class Principal:
    user_id: str
    roles: tuple[str, ...]
    bearer: str | None

    def identity_headers(self):
        """Cabeçalhos de identidade para chamadas feitas em nome deste usuário."""
        headers = {"X-User-Id": self.user_id}
        if self.roles:
            headers["X-User-Roles"] = ",".join(self.roles)
        # Bearer repassado sem verificação (o gateway já o verificou); Eventos o usa nas próprias checagens.
        if self.bearer:
            headers["Authorization"] = "Bearer " + self.bearer
        return headers


class Authenticator:
    def __init__(self, settings):
        self.settings = settings

    def authenticate(self, headers):
        # Código único: nunca revelar qual verificação falhou.
        try:
            user_id = str(UUID(headers.get("X-User-Id", "").strip()))
        except ValueError as exc:
            raise DomainError(401, "UNAUTHENTICATED") from exc
        roles = tuple(r for r in (part.strip() for part in headers.get("X-User-Roles", "").split(",")) if r)
        # O Bearer NÃO é verificado aqui (o gateway já o fez); é só repassado a Eventos,
        # que o usa nas próprias checagens de permissão.
        authorization = headers.get("Authorization", "")
        bearer = authorization[7:].strip() or None if authorization.startswith("Bearer ") else None
        return Principal(user_id, roles, bearer)
