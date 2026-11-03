# Certificates service

Stage 1 provides the microservice's FastAPI foundation. Eligibility rules,
certificate issuance, the definitive data model, and migrations have not been
implemented yet. A database is required for the health check: if `DATABASE_URL`
is missing or the connection fails, `GET /healthcheck` returns `503` without
internal details.

## Structure

- `app/main.py`: FastAPI application setup and routes.
- `app/config.py`: settings loaded from the environment.
- `app/database.py`: SQLAlchemy declarative base and connectivity check; does
  not run migrations.
- `app/integrations/discovery.py`: initial adapter for the internal `discovery`
  library. Registration is not triggered automatically at this stage.
- `app/models/`, `app/schemas/`, `app/services/`: extension points with no
  business rules implemented.
- `tests/unit/` and `tests/integration/`: tests that do not require PostgreSQL.

## Dependencies

Direct Python dependencies are pinned in `requirements.txt`: FastAPI, Uvicorn,
SQLAlchemy, Alembic, Pydantic Settings, psycopg, ReportLab, and Pytest. `httpx`
is included for FastAPI's `TestClient`. The internal `discovery` library is
installed separately from `service-discoverer/Libs/python`.

For development, from `certificates/`:

```shell
python -m pip install -r requirements.txt
python -m pip install ../service-discoverer/Libs/python
python -m pytest
```

The Dockerfile receives the internal library as a named `discovery` context.
Therefore, the `certificates` service in the main Compose file declares
`additional_contexts` pointing to `service-discoverer/Libs/python`.

## Planned environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | not configured | Required for health. Use `postgresql+psycopg://...`; if missing or the connection fails, the endpoint returns `503`. In the main Compose file, it receives `CERTIFICATES_DATABASE_URL`. |
| `SERVICE_DISCOVERER_URL` | `http://service-discoverer:8080` | Base URL also read by the internal discovery library. |
| `SERVICE_HOST` | not configured | Host announced to the discoverer when registration is enabled. |
| `PORT` | `8080` | Fallback used by the discovery library to build the announced host; Uvicorn is configured to listen on port `8080`. |
| `CERTIFICATES_DB_USER` | `certificates` | User configured for the local Compose PostgreSQL database. |
| `CERTIFICATES_DB_PASSWORD` | not configured | Password supplied to the local PostgreSQL database; must be set in the environment or `.env` file. |
| `CERTIFICATES_DATABASE_URL` | not configured | URL passed as `DATABASE_URL` by the main Compose file. It must point to `certificates-db` and match the PostgreSQL credentials. |

No secrets are committed to the repository. Compose includes PostgreSQL 16 on
the private `certificates-net` network, with no host port published and a
persistent volume. Set `CERTIFICATES_DB_PASSWORD` and
`CERTIFICATES_DATABASE_URL` in the environment or a local `.env` file before
starting Compose. The full URL must use the `postgresql+psycopg` driver and
match the user, password, and `certificates` database; special characters in
credentials must be URL-encoded. The database will not start with an empty
password. The `service_healthy` condition controls startup order; it does not
replace the application's ongoing connection check.

## Service discovery

The adapter imports `Kind.CERTIFICATES` and `register` from the internal
library, but registration is not active in the application's lifecycle. The
library reads `SERVICE_DISCOVERER_URL`, `SERVICE_HOST`, and `PORT`;
`register()` may block for about 2.5 minutes and then raise `RuntimeError` if
the discoverer is unavailable. Before enabling it, the Python service still
needs a retry and re-registration policy. Application startup does not contact
the discoverer.

## Run

```shell
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

The `/healthcheck` endpoint returns `200` only when `DATABASE_URL` is
configured and `SELECT 1` succeeds; otherwise, it returns `503`. PostgreSQL
does not need to be running for isolated tests: connectivity tests use
in-memory SQLite or mock the check. FastAPI also provides `GET /openapi.json`.

To start the application and its local database with the main Compose file, set
the two database variables above and run this command from the repository root:

```shell
docker compose up --build certificates
```
