"""Rotas reais ASGI e identidade por cabeçalhos do gateway (o JWT é verificado no gateway)."""

from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from test_service import activity

from app.api import create_app
from app.contracts import DomainError
from app.integrations import Services
from app.security import Authenticator


def auth_of(settings, **headers):
    return Authenticator(settings).authenticate(headers)


def test_headers_identity_and_roles(settings):
    user = str(uuid4())
    who = auth_of(settings, **{"X-User-Id": user.upper(), "X-User-Roles": "PARTICIPANT"})
    assert who.user_id == user
    assert who.roles == ("PARTICIPANT",)
    assert who.bearer is None
    assert auth_of(settings, **{"X-User-Id": user, "X-User-Roles": " ORGANIZER , PARTICIPANT,, "}).roles == (
        "ORGANIZER",
        "PARTICIPANT",
    )
    assert auth_of(settings, **{"X-User-Id": user}).roles == ()
    assert auth_of(settings, **{"X-User-Id": user, "X-User-Roles": " "}).roles == ()


@pytest.mark.parametrize("value", [None, "", "   ", "not-a-uuid"])
def test_missing_or_invalid_user_id(settings, value):
    headers = {} if value is None else {"X-User-Id": value}
    with pytest.raises(DomainError, match="UNAUTHENTICATED") as caught:
        auth_of(settings, **headers)
    assert caught.value.status == 401


def test_bearer_extraction(settings):
    user = str(uuid4())
    assert auth_of(settings, **{"X-User-Id": user, "Authorization": "Bearer abc.def"}).bearer == "abc.def"
    assert auth_of(settings, **{"X-User-Id": user, "Authorization": "Basic abc"}).bearer is None


class FakeEvents:
    """Substitui somente o serviço ainda inexistente, não a lógica da aplicação."""

    def __init__(self, act):
        self.act = act
        self.allowed = True
        self.headers = []

    def activity(self, activity_id, headers=None):
        self.headers.append(headers)
        return self.act

    def authorize_organizer(self, activity_id, headers):
        self.headers.append(headers)
        if not self.allowed:
            raise DomainError(403, "FORBIDDEN")

    def close(self):
        pass


def ident(user=None, roles=None, **extra):
    headers = {"X-User-Id": user or str(uuid4()), **extra}
    if roles is not None:
        headers["X-User-Roles"] = roles
    return headers


def test_api_headers_ownership_gateway_contract(db, settings):
    act = activity()
    external = FakeEvents(act)
    app = create_app(settings, db, external, Authenticator(settings))
    user = str(uuid4())
    headers = ident(user, "PARTICIPANT")
    with TestClient(app) as client:
        spec = client.get("/openapi.json").json()
        assert "/api/v1/registrations/me" in spec["paths"]
        assert client.get("/healthcheck").status_code == 200
        denied = client.get("/api/v1/registrations/me")
        assert denied.status_code == 401
        assert denied.json()["code"] == "UNAUTHENTICATED"
        assert client.get("/api/v1/registrations/me", headers=ident(user)).status_code == 200
        url = f"/api/v1/activities/{act.activity_id}/registrations"
        assert client.post(url, headers=headers, json={"user_id": str(uuid4())}).status_code == 422
        response = client.post(url, headers=headers, json={})
        assert response.status_code == 201
        assert response.headers["X-Request-Id"]
        reg = response.json()
        assert reg["user_id"] == user
        original_activity = external.activity

        def unavailable(*args):
            raise DomainError(503, "DEPENDENCY_UNAVAILABLE")

        external.activity = unavailable
        again = client.post(url, headers=headers, json={})
        assert again.status_code == 200
        assert again.json() == reg
        external.activity = original_activity
        availability = client.get(url.replace("/registrations", "/availability"), headers=headers).json()
        assert availability["available"] == 0
        other = ident(roles="PARTICIPANT")
        assert client.get(f"/api/v1/registrations/{reg['id']}", headers=other).status_code == 404
        assert client.post(f"/api/v1/registrations/{reg['id']}/cancel", headers=other).status_code == 404
        assert client.get(url, headers=headers).status_code == 403
        organizer = ident(roles="ORGANIZER")
        external.allowed = False
        assert client.get(url, headers=organizer).status_code == 403
        external.allowed = True
        assert client.get(url, headers=organizer).status_code == 200


def test_identity_ignores_body_user_id(db, settings):
    act = activity()
    app = create_app(settings, db, FakeEvents(act), Authenticator(settings))
    user = str(uuid4())
    url = f"/api/v1/activities/{act.activity_id}/registrations"
    with TestClient(app) as client:
        rejected = client.post(url, headers=ident(user), json={"user_id": str(uuid4())})
        assert rejected.status_code == 422
        created = client.post(url, headers=ident(user), json={})
        assert created.json()["user_id"] == user


def test_bearer_forwarded_to_events_and_optional(db, settings):
    act = activity()
    external = FakeEvents(act)
    app = create_app(settings, db, external, Authenticator(settings))
    url = f"/api/v1/activities/{act.activity_id}/availability"
    with TestClient(app) as client:
        assert client.get(url, headers=ident(Authorization="Bearer tok.en.1")).status_code == 200
        assert external.headers[-1]["Authorization"] == "Bearer tok.en.1"
        assert client.get(url, headers=ident()).status_code == 200
        assert "Authorization" not in external.headers[-1]


def test_identity_headers_sent_to_events_on_every_route(db, settings):
    act = activity()
    external = FakeEvents(act)
    app = create_app(settings, db, external, Authenticator(settings))
    user = str(uuid4())
    roles = "ORGANIZER,PARTICIPANT"
    base = f"/api/v1/activities/{act.activity_id}"

    def check(response, expected_status, bearer="Bearer tok.en.9"):
        assert response.status_code in expected_status, response.text
        sent = external.headers[-1]
        assert sent["X-User-Id"] == user
        assert sent["X-User-Roles"] == roles
        assert sent["X-Request-Id"]
        assert sent["X-Request-Id"] == response.headers["X-Request-Id"]
        assert sent.get("Authorization") == bearer

    with TestClient(app) as client:
        for bearer in ("Bearer tok.en.9", None):
            extra = {"Authorization": bearer} if bearer else {}
            headers = ident(user, roles, **extra)
            check(client.post(base + "/registrations", headers=headers, json={}), (201,), bearer)
            reg = client.post(base + "/registrations", headers=headers, json={}).json()
            check(client.get(base + "/availability", headers=headers), (200,), bearer)
            # Idempotência: com inscrição viva a rota nem consulta Eventos; o accept consulta.
            # Regras de estado podem recusar (409) depois de consultar Eventos; só a chamada importa.
            check(client.post(f"/api/v1/registrations/{reg['id']}/accept-offer", headers=headers), (200, 409), bearer)
            check(client.get(base + "/registrations", headers=headers), (200,), bearer)
            check(client.post(f"/api/v1/registrations/{reg['id']}/check-in", headers=headers), (200, 409), bearer)
            client.post(f"/api/v1/registrations/{reg['id']}/cancel", headers=headers)


def test_accept_offer_sends_identity_headers(db, settings):
    act = activity()
    external = FakeEvents(act)
    app = create_app(settings, db, external, Authenticator(settings))
    user = str(uuid4())
    headers = ident(user, "PARTICIPANT", Authorization="Bearer tok.en.7")
    with TestClient(app) as client:
        reg = client.post(f"/api/v1/activities/{act.activity_id}/registrations", headers=headers, json={}).json()
        response = client.post(f"/api/v1/registrations/{reg['id']}/accept-offer", headers=headers)
        # O estado da inscrição pode rejeitar o aceite; o que importa aqui é a chamada a Eventos.
        assert response.status_code in (200, 409)
        sent = external.headers[-1]
        assert sent["X-User-Id"] == user
        assert sent["X-User-Roles"] == "PARTICIPANT"
        assert sent["X-Request-Id"] == response.headers["X-Request-Id"]
        assert sent["Authorization"] == "Bearer tok.en.7"


def test_openapi_has_no_identity_parameters(db, settings):
    app = create_app(settings, db, FakeEvents(activity()), Authenticator(settings))
    with TestClient(app) as client:
        spec = client.get("/openapi.json").text.lower()
    for name in ("x-user-id", "x-user-roles", "authorization"):
        assert name not in spec


def test_services_get_without_bearer_sends_no_authorization(settings):
    seen = []

    def handler(request):
        seen.append(request)
        if request.url.path == "/consult":
            return httpx.Response(200, json={"host": "events:8080"})
        return httpx.Response(200, json={})

    services = Services(settings, httpx.Client(transport=httpx.MockTransport(handler)))
    services.get("events", "/x")
    assert "Authorization" not in seen[-1].headers
    services.close()


def test_discovery_and_activity_http_contract(settings):
    act = activity()
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path == "/consult":
            return httpx.Response(200, json={"host": "events:8080"})
        return httpx.Response(200, json=act.model_dump(mode="json"))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    services = Services(settings, client)
    sent = {"X-User-Id": str(uuid4()), "X-User-Roles": "ORGANIZER", "X-Request-Id": "trace-12345678", "Authorization": "Bearer verified-token"}
    assert services.activity(act.activity_id, sent) == act
    for name, value in sent.items():
        assert calls[-1].headers[name] == value
    assert "X-Service-Token" not in calls[-1].headers
    assert calls[-1].url.path == f"/api/v1/activities/{act.activity_id}"
    # Caminho dos workers: sem chamador, nenhuma identidade.
    assert services.activity(act.activity_id) == act
    for name in ("X-User-Id", "X-User-Roles", "X-Request-Id", "Authorization", "X-Service-Token"):
        assert name not in calls[-1].headers
    services.close()


def test_signup_is_idempotent_per_user_and_activity(db, settings):
    act = activity()
    external = FakeEvents(act)
    app = create_app(settings, db, external, Authenticator(settings))
    user = str(uuid4())
    url = f"/api/v1/activities/{act.activity_id}/registrations"
    with TestClient(app) as client:
        spec = client.get("/openapi.json").json()
        params = spec["paths"][url.replace(str(act.activity_id), "{activity_id}")]["post"].get("parameters", [])
        assert not any("idempotency" in p["name"].lower() for p in params)
        first = client.post(url, headers=ident(user), json={})
        assert first.status_code == 201

        def unavailable(*args):
            raise DomainError(503, "DEPENDENCY_UNAVAILABLE")

        external.activity = unavailable
        # Cabeçalho legado é ignorado; repetição não depende de Eventos e ignora join_waitlist.
        second = client.post(url, headers=ident(user, **{"Idempotency-Key": "stray"}), json={"join_waitlist": False})
        assert second.status_code == 200
        assert second.json() == first.json()
        # Sem inscrição viva, a falha de Eventos volta a valer.
        assert client.post(url, headers=ident(), json={}).status_code == 503
