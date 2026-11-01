#!/bin/sh
# Makes the events service endpoints reachable through the Gateway admin API (PUT /admin/endpoints).
# The Gateway learns the endpoints from GET /openapi.json but registers them PRIVATE (404); this opens them.
# Settings live in the Gateway database, so run it once after the Gateway synced the "events" kind.
#
# The admin API has no authentication and no host port: run this from inside the Docker network, e.g.
#   docker run --rm --network <project>_backbone -v "$PWD/events/scripts:/s:ro" \
#     -e GATEWAY_ADMIN_URL=http://gateway:8080 --entrypoint sh curlimages/curl:8.10.1 /s/register-gateway-routes.sh
#
# requireAuth stays false on purpose: the Gateway only checks that an X-User-Id header EXISTS, while the events
# service validates the bearer token itself (public reads need no token at all). rateLimitBy=ip because
# user_or_ip trusts the client-controlled X-User-Id header.
set -eu
: "${GATEWAY_ADMIN_URL:?set GATEWAY_ADMIN_URL, e.g. http://gateway:8080}"

open_endpoint() { # method path maxPerMin
  curl -fsS -X PUT "$GATEWAY_ADMIN_URL/admin/endpoints" -H 'Content-Type: application/json' \
    -d "{\"kind\":\"events\",\"method\":\"$1\",\"path\":\"$2\",\"isPublic\":true,\"requireAuth\":false,\"maxPerMin\":$3,\"rateLimitBy\":\"ip\"}" > /dev/null
  echo "public: $1 /events$2 (max $3/min per IP)"
}

# Reads: high limits, they take the 20x load of registration openings (RQ02).
open_endpoint GET    /events                                600
open_endpoint GET    /events/{eventId}                      600
open_endpoint GET    /events/{eventId}/activities           600
open_endpoint GET    /activities/{activityId}               600
open_endpoint GET    /me/events                             120
# Organizer changes.
open_endpoint POST   /events                                30
open_endpoint PATCH  /events/{eventId}                      60
open_endpoint POST   /events/{eventId}/publish              30
open_endpoint POST   /events/{eventId}/cancel               30
open_endpoint POST   /events/{eventId}/activities           60
open_endpoint PATCH  /activities/{activityId}               60
open_endpoint DELETE /activities/{activityId}               30
# Not opened on purpose: /healthcheck and /openapi.json are internal (hidden from the spec anyway).
