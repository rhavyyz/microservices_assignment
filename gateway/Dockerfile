# Image for the gateway: UI-facing call forwarder with a middleware pipeline (Go).
# Routes /{kind}/... to a healthy instance of that kind (found via the service-discoverer) and keeps its endpoint table in MongoDB (gateway-db).
# Also serves GET /ws, forwarding the notifications-push Kafka topic to the websocket of the target user.
# Discovery goes through the shared Go discovery lib, from the compose build context "discovery" (service-discoverer/Libs/go),
# copied to /service-discoverer/Libs/go so go.mod's `replace ../service-discoverer/Libs/go` resolves the same as in the repo (/src is gateway/).
# Multi-stage build producing a small static binary listening on $PORT (default 8080).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY --from=discovery . /service-discoverer/Libs/go
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -o /gateway .

FROM alpine:3.20
COPY --from=build /gateway /gateway
EXPOSE 8080
CMD ["/gateway"]
