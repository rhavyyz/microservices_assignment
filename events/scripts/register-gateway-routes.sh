#!/bin/sh
# Makes the events service endpoints reachable through the Gateway admin API (PUT /admin/endpoints).
# The Gateway learns the endpoints from GET /openapi.json but registers them PRIVATE (404); this opens them.
# Settings live in the Gateway database, so run it once after the Gateway synced the "events" kind.
#
# The admin API has no authentication and no host port: run this from inside the Docker network, e.g.
#   docker run --rm --network <project>_backbone -v "$PWD/events/scripts:/s:ro" \
#     -e GATEWAY_ADMIN_URL=http://gateway:8080 --entrypoint sh curlimages/curl:8.10.1 /s/register-gateway-routes.sh
#
# Identity: the Gateway verifies the JWT and sends X-User-Id / X-User-Roles (it drops any client-sent value); the events
# service trusts only those headers. Public reads keep requireAuth=false, rateLimitBy=ip (anonymous visitors; a token, when
# sent, still makes the Gateway inject the identity, so an organizer sees their drafts). Every route that changes
# something, /me/events and the activity end need a user: requireAuth=true, rateLimitBy=user_or_ip.
# GET /api/v1/activities/{activity_id}/permissions/me is NOT opened: Subscription calls it directly through the discoverer.
set -eu
: "${GATEWAY_ADMIN_URL:?set GATEWAY_ADMIN_URL, e.g. http://gateway:8080}"

open_endpoint() { # method path maxPerMin requireAuth rateLimitBy
  curl -fsS -X PUT "$GATEWAY_ADMIN_URL/admin/endpoints" -H 'Content-Type: application/json' \
    -d "{\"kind\":\"events\",\"method\":\"$1\",\"path\":\"$2\",\"isPublic\":true,\"requireAuth\":$4,\"maxPerMin\":$3,\"rateLimitBy\":\"$5\"}" > /dev/null
  echo "public: $1 /events$2 (max $3/min by $5, requireAuth=$4)"
}
read_endpoint() { open_endpoint "$1" "$2" "$3" false ip; }
user_endpoint() { open_endpoint "$1" "$2" "$3" true user_or_ip; }

# Reads: high limits, they take the 20x load of registration openings (RQ02).
read_endpoint GET    /api/v1/events                                600
read_endpoint GET    /api/v1/events/{event_id}                     600
read_endpoint GET    /api/v1/events/{event_id}/activities          600
read_endpoint GET    /api/v1/activities/{activity_id}              600
user_endpoint GET    /api/v1/me/events                             120
# Organizer changes.
user_endpoint POST   /api/v1/events                                30
user_endpoint PATCH  /api/v1/events/{event_id}                     60
user_endpoint POST   /api/v1/events/{event_id}/publish             30
user_endpoint POST   /api/v1/events/{event_id}/cancel              30
user_endpoint POST   /api/v1/events/{event_id}/activities          60
user_endpoint PATCH  /api/v1/activities/{activity_id}              60
user_endpoint POST   /api/v1/activities/{activity_id}/end          30
user_endpoint DELETE /api/v1/activities/{activity_id}              30
# Not opened on purpose: /healthcheck and /openapi.json (internal, hidden from the spec anyway) and
# /api/v1/activities/{activity_id}/permissions/me (internal, called by Subscription through the discoverer).
