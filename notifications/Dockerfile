# Image for the notifications service: consumes user notifications from Kafka and stores them in its own MongoDB (Go).
# Registers with the service-discoverer as kind "notifications" and serves /healthcheck and /openapi.json.
# Multi-stage build producing a small static binary listening on $PORT (default 8080).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -o /notifications .

FROM alpine:3.20
COPY --from=build /notifications /notifications
EXPOSE 8080
CMD ["/notifications"]
