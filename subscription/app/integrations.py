"""HTTP entre serviços: descoberta pela biblioteca compartilhada, fora das transações de negócio."""

from discovery import Kind, register, request

from .contracts import Activity, DomainError


class Services:
    def __init__(self, settings, request=request):
        self.settings = settings
        # Injetável para os testes não dependerem de rede nem do discoverer.
        self.request = request

    def register(self):
        register(Kind.SUBSCRIPTION)

    def get(self, kind, path, headers=None):
        # Envia apenas o que o chamador informar; chamadas de fundo (workers) não levam identidade.
        try:
            response = self.request("GET", Kind(kind), path, {"headers": headers or {}})
            status = response.status
            body = response.json() if 200 <= status < 300 else None
        except Exception as exc:
            raise DomainError(503, "DEPENDENCY_UNAVAILABLE") from exc
        if status == 404:
            raise DomainError(404, "RESOURCE_NOT_FOUND")
        if status in (401, 403):
            raise DomainError(403, "FORBIDDEN")
        if body is None:
            raise DomainError(503, "DEPENDENCY_UNAVAILABLE")
        return body

    def activity(self, activity_id, headers=None):
        try:
            activity = Activity.model_validate(
                self.get(Kind.EVENTS, f"/api/v1/activities/{activity_id}", headers)
            )
            if str(activity.activity_id) != str(activity_id):
                raise ValueError("Atividade divergente")
            return activity
        except ValueError as exc:
            raise DomainError(503, "INVALID_EVENTS_CONTRACT") from exc

    def authorize_organizer(self, activity_id, headers):
        # Eventos decide a propriedade atual. Não confiamos apenas no papel informado pelo gateway.
        result = self.get(Kind.EVENTS, f"/api/v1/activities/{activity_id}/permissions/me", headers)
        if result.get("can_manage") is not True:
            raise DomainError(403, "FORBIDDEN")
