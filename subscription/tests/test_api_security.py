"""Rotas reais ASGI, controle de acesso e assinatura criptográfica RS256."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from test_service import activity

from app.api import create_app
from app.contracts import DomainError
from app.integrations import Services
from app.security import Authenticator


@pytest.fixture
def keys():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(keys, **overrides):
    now = datetime.now(timezone.utc)
    claims = {
        "sub": str(uuid4()),
        "iss": "eventhub-users",
        "iat": now,
        "exp": now + timedelta(minutes=5),
        "roles": ["PARTICIPANT"],
    }
    claims.update(overrides)
    return jwt.encode(claims, keys, algorithm="RS256", headers={"kid": "test"})


def authenticator(settings, keys):
    config = replace(settings, jwks_url="http://users/.well-known/jwks.json")
    auth = Authenticator(config, None)
    auth.clients[config.jwks_url] = SimpleNamespace(
        get_signing_key_from_jwt=lambda _: SimpleNamespace(key=keys.public_key())
    )
    return auth


def test_valid_signature_and_subject(settings, keys):
    user = str(uuid4())
    who = authenticator(settings, keys).authenticate("Bearer " + token(keys, sub=user))
    assert who.user_id == user
    assert who.roles == ("PARTICIPANT",)


@pytest.mark.parametrize(
    "change",
    [
        {"iss": "foreign"},
        {"exp": 1},
        {"sub": "not-a-uuid"},
        {"roles": "ORGANIZER"},
    ],
)
def test_invalid_claims(settings, keys, change):
    with pytest.raises(DomainError, match="INVALID_TOKEN"):
        authenticator(settings, keys).authenticate("Bearer " + token(keys, **change))


def test_foreign_signature_and_missing_bearer(settings, keys):
    auth = authenticator(settings, keys)
    foreign = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(DomainError):
        auth.authenticate("Bearer " + token(foreign))
    with pytest.raises(DomainError):
        auth.authenticate(None)


class FakeEvents:
    """Substitui somente o serviço ainda inexistente, não a lógica da aplicação."""

    def __init__(self, act):
        self.act = act
        self.allowed = True

    def activity(self, activity_id, bearer=None):
        return self.act

    def authorize_organizer(self, activity_id, bearer):
        if not self.allowed:
            raise DomainError(403, "FORBIDDEN")

    def close(self):
        pass


def test_api_auth_ownership_gateway_contract(db, settings, keys):
    act = activity()
    external = FakeEvents(act)
    app = create_app(settings, db, external, authenticator(settings, keys))
    user = str(uuid4())
    headers = {"Authorization": "Bearer " + token(keys, sub=user), "Idempotency-Key": "first"}
    with TestClient(app) as client:
        spec = client.get("/openapi.json").json()
        assert "/api/v1/registrations/me" in spec["paths"]
        assert client.get("/healthcheck").status_code == 200
        assert client.get("/api/v1/registrations/me", headers={"X-User-Id": user}).status_code == 401
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
        assert client.post(url, headers=headers, json={}).json() == reg
        external.activity = original_activity
        availability = client.get(url.replace("/registrations", "/availability"), headers=headers).json()
        assert availability["available"] == 0
        other = {"Authorization": "Bearer " + token(keys)}
        assert client.get(f"/api/v1/registrations/{reg['id']}", headers=other).status_code == 404
        assert client.post(f"/api/v1/registrations/{reg['id']}/cancel", headers=other).status_code == 404
        assert client.get(url, headers=headers).status_code == 403
        organizer = {"Authorization": "Bearer " + token(keys, roles=["ORGANIZER"])}
        external.allowed = False
        assert client.get(url, headers=organizer).status_code == 403
        external.allowed = True
        assert client.get(url, headers=organizer).status_code == 200


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
    assert services.activity(act.activity_id, "verified-token") == act
    assert calls[-1].headers["Authorization"] == "Bearer verified-token"
    assert calls[-1].url.path == f"/api/v1/activities/{act.activity_id}"
    services.close()
