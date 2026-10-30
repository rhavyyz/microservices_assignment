# Image for the service-discoverer: an in-memory registry of service instances (Go).
# Instances POST /register on startup; other services GET /consult?kind=... to get a healthy host.
# Multi-stage build producing a small static binary listening on $PORT (default 8080).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -o /service-discoverer .

FROM alpine:3.20
COPY --from=build /service-discoverer /service-discoverer
EXPOSE 8080
CMD ["/service-discoverer"]
