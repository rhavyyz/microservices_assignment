#!/bin/sh
# Opens the two certificate routes the frontend needs through the Gateway admin API (PUT /admin/endpoints).
# The Gateway learns the endpoints from GET /openapi.json but registers them PRIVATE (404); this opens only
# the two GET routes below. /healthcheck and /openapi.json stay private. Settings live in the Gateway database,
# so run it once after the Gateway synced the "certificates" kind.
#
# The Gateway publishes port 8080 on the host, so from the repository root:
#   GATEWAY_ADMIN_URL=http://localhost:8080 sh certificates/scripts/register_gateway.sh
# WARNING: the admin API has NO authentication (see gateway/admin.go). Keep it to a local machine or a trusted network.
#
# requireAuth is true: the Gateway verifies the JWT and injects X-User-Id / X-User-Roles, which is the only identity
# the Certificates service trusts (it never sees or checks the token). Being per-user, the limit uses user_or_ip.
set -eu
: "${GATEWAY_ADMIN_URL:?set GATEWAY_ADMIN_URL, e.g. http://gateway:8080}"

open_endpoint() { # method path maxPerMin
  curl -fsS -X PUT "$GATEWAY_ADMIN_URL/admin/endpoints" -H 'Content-Type: application/json' \
    -d "{\"kind\":\"certificates\",\"method\":\"$1\",\"path\":\"$2\",\"isPublic\":true,\"requireAuth\":true,\"maxPerMin\":$3,\"rateLimitBy\":\"user_or_ip\"}" > /dev/null
  echo "public: $1 /certificates$2 (max $3/min, by user_or_ip)"
}

open_endpoint GET /api/v1/certificates/me 120
open_endpoint GET '/api/v1/certificates/{certificate_id}' 60
# Not opened on purpose: /healthcheck and /openapi.json (internal).
