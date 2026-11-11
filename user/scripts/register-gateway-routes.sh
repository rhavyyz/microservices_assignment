#!/bin/sh
# Makes the user service endpoints reachable through the Gateway admin API (PUT /admin/endpoints).
# The Gateway learns the endpoints from GET /openapi.json but registers them PRIVATE (404); this opens the ones
# the frontend needs. Settings live in the Gateway database, so run it once after the Gateway synced the "user" kind.
#
# The Gateway publishes port 8080 on the host, so from the repository root:
#   GATEWAY_ADMIN_URL=http://localhost:8080 sh user/scripts/register-gateway-routes.sh
# WARNING: the admin API has NO authentication (see gateway/admin.go). Anyone who can reach port 8080 can change
# routes and limits; keep it to a local machine or a trusted network.
#
# requireAuth stays false on purpose, even though the Gateway now verifies the JWT: with false, a missing/expired
# token still reaches the user service, which answers a uniform application/problem+json 401 (UNAUTHENTICATED);
# with true the Gateway itself would answer a plain-text 401/503. The user service validates the JWT either way.
# The Gateway still sets X-User-Id from a VALID token on every route, so rateLimitBy=user_or_ip is a per-user limit
# for authenticated routes (an invalid or missing token falls back to the IP). Public routes (register, login)
# have no identity, so they use the IP.
set -eu
: "${GATEWAY_ADMIN_URL:?set GATEWAY_ADMIN_URL, e.g. http://gateway:8080}"

open_endpoint() { # method path maxPerMin rateLimitBy
  curl -fsS -X PUT "$GATEWAY_ADMIN_URL/admin/endpoints" -H 'Content-Type: application/json' \
    -d "{\"kind\":\"user\",\"method\":\"$1\",\"path\":\"$2\",\"isPublic\":true,\"requireAuth\":false,\"maxPerMin\":$3,\"rateLimitBy\":\"$4\"}" > /dev/null
  echo "public: $1 /user$2 (max $3/min, by $4)"
}

open_endpoint POST  /api/v1/auth/register 10  ip
open_endpoint POST  /api/v1/auth/login    10  ip
open_endpoint GET   /api/v1/users/me      120 user_or_ip
open_endpoint PATCH /api/v1/users/me      30  user_or_ip
open_endpoint GET   /api/v1/users         60  user_or_ip   # search; ORGANIZER only (the service checks the role)
open_endpoint GET   /api/v1/admin/users                 60  user_or_ip   # ADMIN only (the service checks the role)
open_endpoint PUT   /api/v1/admin/users/{id}/organizer  30  user_or_ip   # ADMIN only
# Not opened on purpose: /healthcheck and /openapi.json (internal) and /.well-known/jwks.json (other services
# fetch it directly through the service-discoverer, see docs/integration/contracts-with-team.md).
# Also not opened, never: GET /internal/users/{id} (unauthenticated id+name lookup for other services; network only).
