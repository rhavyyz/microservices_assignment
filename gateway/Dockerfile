# Image for the gateway: UI-facing call forwarder with a middleware pipeline (Go).
# Routes /{kind}/... to a healthy instance of that kind (found via the service-discoverer) and keeps its endpoint table in MongoDB (gateway-db).
# Multi-stage build producing a small static binary listening on $PORT (default 8080).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -o /gateway .

FROM alpine:3.20
COPY --from=build /gateway /gateway
EXPOSE 8080
CMD ["/gateway"]
