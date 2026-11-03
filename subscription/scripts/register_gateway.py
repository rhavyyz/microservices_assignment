"""Publica somente as rotas de negócio; executar explicitamente após iniciar o gateway.

Exemplo: python scripts/register_gateway.py --gateway http://localhost:8080
Não abre healthcheck, OpenAPI nem uma API de administração do serviço.
"""

import argparse

import httpx

ROUTES = [
    ("POST", "/api/v1/activities/{activity_id}/registrations", 30),
    ("GET", "/api/v1/activities/{activity_id}/availability", 120),
    ("GET", "/api/v1/registrations/me", 120),
    ("GET", "/api/v1/registrations/{registration_id}", 120),
    ("POST", "/api/v1/registrations/{registration_id}/cancel", 30),
    ("POST", "/api/v1/registrations/{registration_id}/accept-offer", 30),
    ("GET", "/api/v1/activities/{activity_id}/registrations", 60),
    ("POST", "/api/v1/registrations/{registration_id}/check-in", 120),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway", required=True)
    args = parser.parse_args()
    with httpx.Client(timeout=10) as client:
        for method, path, limit in ROUTES:
            response = client.put(
                args.gateway.rstrip("/") + "/admin/endpoints",
                json={
                    "kind": "subscription",
                    "method": method,
                    "path": path,
                    "isPublic": True,
                    "requireAuth": True,
                    "rateLimitBy": "user_or_ip",
                    "maxPerMin": limit,
                },
            )
            # O gateway verifica o JWT e injeta X-User-Id/X-User-Roles; Inscrições confia nesses cabeçalhos.
            response.raise_for_status()
            print(method, path, response.status_code)


if __name__ == "__main__":
    main()
