def test_application_initializes_and_exposes_openapi(client):
    response = client.get("/openapi.json")

    assert response.status_code == 200
    assert "/healthcheck" in response.json()["paths"]


def test_openapi_documents_every_route_and_hides_docs(client):
    response = client.get("/openapi.json")
    spec = response.json()

    assert set(spec["paths"]) == {
        "/healthcheck",
        "/api/v1/certificates/me",
        "/api/v1/certificates/{certificate_id}",
    }
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404

    download = spec["paths"]["/api/v1/certificates/{certificate_id}"]["get"]
    assert "application/pdf" in download["responses"]["200"]["content"]
    for status in ("401", "404", "503"):
        assert "application/problem+json" in download["responses"][status]["content"]

    listing = spec["paths"]["/api/v1/certificates/me"]["get"]
    for status in ("401", "503"):
        assert "application/problem+json" in listing["responses"][status]["content"]
    # Identity comes from gateway headers and is not part of the public contract.
    assert not [p for p in listing.get("parameters", []) if p["name"].lower() == "x-user-id"]
