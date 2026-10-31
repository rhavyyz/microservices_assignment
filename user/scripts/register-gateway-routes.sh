#!/bin/sh
# Makes the user service endpoints reachable through the Gateway admin API (PUT /admin/endpoints).
# The Gateway learns the endpoints from GET /openapi.json but registers them PRIVATE (404); this opens the ones
# the frontend needs. Settings live in the Gateway database, so run it once after the Gateway synced the "user" kind.
#
# The admin API has no authentication and no host port: run this from inside the Docker network, e.g.
#   docker run --rm --network <project>_backbone -v "$PWD/user/scripts:/s:ro" \
#     -e GATEWAY_ADMIN_URL=http://gateway:8080 --entrypoint sh curlimages/curl:8.10.1 /s/register-gateway-routes.sh
#
# requireAuth stays false on purpose: today the Gateway only checks that an X-User-Id header EXISTS (any client can
# send one), while the user service validates the JWT itself. rateLimitBy=ip because user_or_ip trusts X-User-Id.
set -eu
: "${GATEWAY_ADMIN_URL:?set GATEWAY_ADMIN_URL, e.g. http://gateway:8080}"

open_endpoint() { # method path maxPerMin
  curl -fsS -X PUT "$GATEWAY_ADMIN_URL/admin/endpoints" -H 'Content-Type: application/json' \
    -d "{\"kind\":\"user\",\"method\":\"$1\",\"path\":\"$2\",\"isPublic\":true,\"requireAuth\":false,\"maxPerMin\":$3,\"rateLimitBy\":\"ip\"}" > /dev/null
  echo "public: $1 /user$2 (max $3/min per IP)"
}

open_endpoint POST  /api/v1/auth/register 10
open_endpoint POST  /api/v1/auth/login    10
open_endpoint GET   /api/v1/users/me      120
open_endpoint PATCH /api/v1/users/me      30
# Not opened on purpose: /healthcheck and /openapi.json (internal) and /.well-known/jwks.json (other services
# fetch it directly through the service-discoverer, see docs/integration/contracts-with-team.md).
