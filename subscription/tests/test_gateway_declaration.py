"""O OpenAPI declara em `x-gateway` as configurações de cada operação para o gateway."""

from app.api import create_app

PROTECTED = {"isPublic": True, "requireAuth": True}
HIDDEN = {"isPublic": False, "requireAuth": False}

EXPECTED = {
    ("post", "/api/v1/activities/{activity_id}/registrations"): PROTECTED,
    ("get", "/api/v1/activities/{activity_id}/availability"): PROTECTED,
    ("get", "/api/v1/registrations/me"): PROTECTED,
    ("get", "/api/v1/registrations/{registration_id}"): PROTECTED,
    ("post", "/api/v1/registrations/{registration_id}/cancel"): PROTECTED,
    ("post", "/api/v1/registrations/{registration_id}/accept-offer"): PROTECTED,
    ("get", "/api/v1/activities/{activity_id}/registrations"): PROTECTED,
    ("post", "/api/v1/registrations/{registration_id}/check-in"): PROTECTED,
    ("get", "/healthcheck"): HIDDEN,
}


def test_every_operation_declares_its_gateway_settings(settings):
    paths = create_app(settings).openapi()["paths"]
    found = {}
    for path, item in paths.items():
        for method, operation in item.items():
            ext = operation.get("x-gateway")
            assert isinstance(ext, dict), f"{method} {path} has no x-gateway"
            assert isinstance(ext.get("isPublic"), bool) and isinstance(ext.get("requireAuth"), bool)
            found[(method, path)] = ext
    assert found == EXPECTED


def test_internal_route_stays_out_of_the_schema(settings):
    assert "/internal/registrations/{registration_id}" not in create_app(settings).openapi()["paths"]
