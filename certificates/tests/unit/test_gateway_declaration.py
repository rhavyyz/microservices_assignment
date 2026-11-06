"""The OpenAPI spec declares each operation's gateway settings in `x-gateway`."""

from app.main import app

PROTECTED = {"isPublic": True, "requireAuth": True}
HIDDEN = {"isPublic": False, "requireAuth": False}

EXPECTED = {
    ("get", "/api/v1/certificates/me"): PROTECTED,
    ("get", "/api/v1/certificates/{certificate_id}"): PROTECTED,
    ("get", "/healthcheck"): HIDDEN,
}


def test_every_operation_declares_its_gateway_settings():
    found = {}
    for path, item in app.openapi()["paths"].items():
        for method, operation in item.items():
            ext = operation.get("x-gateway")
            assert isinstance(ext, dict), f"{method} {path} has no x-gateway"
            assert isinstance(ext.get("isPublic"), bool) and isinstance(ext.get("requireAuth"), bool)
            found[(method, path)] = ext
    assert found == EXPECTED
