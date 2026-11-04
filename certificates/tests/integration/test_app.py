def test_application_initializes_and_exposes_openapi(client):
    response = client.get("/openapi.json")

    assert response.status_code == 200
    assert "/healthcheck" in response.json()["paths"]
