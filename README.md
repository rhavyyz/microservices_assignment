# Monorepo

Docker Compose monorepo of services: service-discoverer, gateway, certificates, events, subscription, payments, user, notifications, reports.

- Each service folder has a `Dockerfile` and a `docker-compose.yml` (its shared infra).
- The root `docker-compose.yml` includes them all and runs one instance per service.

- Kafka (KRaft, single broker) is the shared event bus, reachable from any service at `kafka:9092` on the `backbone` network.

## Run
    docker compose up --build

## Scale
Raise `deploy.replicas` for the service in the root `docker-compose.yml` (every app service sets it explicitly, default `1`), or add another entry for the service (see the `payments-2` example).
