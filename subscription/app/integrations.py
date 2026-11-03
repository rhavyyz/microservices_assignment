"""HTTP entre serviços: descoberta, contratos e timeouts fora das transações de negócio."""

import os
import socket

import httpx

from .contracts import Activity, DomainError, PaymentEvent


class Services:
    def __init__(self, settings, client=None):
        self.settings = settings
        self.http = client or httpx.Client(timeout=5, follow_redirects=False)

    def close(self):
        self.http.close()

    def resolve(self, kind):
        response = self.http.get(self.settings.discoverer_url + "/consult", params={"kind": kind})
        response.raise_for_status()
        host = response.json()["host"]
        # O discoverer devolve host:porta, nunca uma URL ou caminho arbitrário.
        if not isinstance(host, str) or any(c in host for c in "/@?#"):
            raise ValueError("Resposta de descoberta inválida")
        return "http://" + host

    def register(self):
        host = self.settings.service_host or f"{socket.gethostname()}:{os.getenv('PORT', '8080')}"
        self.http.post(
            self.settings.discoverer_url + "/register", json={"kind": "subscription", "host": host}
        ).raise_for_status()

    def get(self, kind, path, headers=None):
        # Envia apenas o que o chamador informar; chamadas de fundo (workers) não levam identidade.
        try:
            response = self.http.get(self.resolve(kind) + path, headers=headers or {})
            if response.status_code == 404:
                raise DomainError(404, "RESOURCE_NOT_FOUND")
            if response.status_code in (401, 403):
                raise DomainError(403, "FORBIDDEN")
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            raise DomainError(503, "DEPENDENCY_UNAVAILABLE") from exc

    def activity(self, activity_id, headers=None):
        try:
            activity = Activity.model_validate(
                self.get("events", f"/api/v1/activities/{activity_id}", headers)
            )
            if str(activity.activity_id) != str(activity_id):
                raise ValueError("Atividade divergente")
            return activity
        except ValueError as exc:
            raise DomainError(503, "INVALID_EVENTS_CONTRACT") from exc

    def authorize_organizer(self, activity_id, headers):
        # Eventos decide a propriedade atual. Não confiamos apenas no papel informado pelo gateway.
        result = self.get("events", f"/api/v1/activities/{activity_id}/permissions/me", headers)
        if result.get("can_manage") is not True:
            raise DomainError(403, "FORBIDDEN")

    def payment(self, attempt_id):
        # 404 não significa recusa: a solicitação pode ainda estar aguardando no Kafka.
        return PaymentEvent.model_validate(self.get("payments", f"/internal/payment-attempts/{attempt_id}"))
