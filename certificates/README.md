# Certificates Service

The Certificates microservice is responsible for generating, storing, and retrieving certificates for participants in events. It uses FastAPI, SQLAlchemy, Alembic, and ReportLab.

The core business logic, certificate data model, database migration, PDF generation, and file storage have been implemented. The current HTTP API exposes a database-aware health check and FastAPI's OpenAPI specification. Public endpoints for certificate issuance and PDF retrieval, as well as integration with other microservices, are still under development.

## Features

- **Eligibility validation:** A certificate can be issued only after the event has ended and the participant meets the minimum attendance requirement.
- **PDF generation:** Certificates are generated as A4 landscape PDF documents using ReportLab.
- **File storage:** Generated PDF files are stored separately from the database.
- **Database persistence:** Certificate metadata is stored using SQLAlchemy, with schema migrations managed by Alembic.
- **Duplicate prevention:** Each registration can have at most one certificate.
- **Health check:** The service checks database connectivity through `GET /healthcheck`.
- **Service discovery adapter:** The service includes an adapter for the project's internal `discovery` library. Automatic registration is not currently enabled in the application lifecycle.

## Project Structure

```text
certificates/
├── app/
│   ├── api/
│   │   └── routes/
│   │       └── certificates.py
│   ├── integrations/
│   │   └── discovery.py
│   ├── models/
│   │   └── certificate.py
│   ├── repositories/
│   │   └── certificate_repository.py
│   ├── schemas/
│   │   └── certificate.py
│   ├── services/
│   │   ├── certificate_service.py
│   │   ├── eligibility.py
│   │   ├── pdf_generator.py
│   │   └── storage.py
│   ├── config.py
│   ├── database.py
│   └── main.py
├── migrations/
├── tests/
│   ├── integration/
│   │   └── test_app.py
│   └── unit/
├── alembic.ini
├── Dockerfile
├── requirements.txt
└── README.md
```

## Eligibility Rules

The current implementation applies the following rules:

1. The event must have ended.
2. The participant must meet the minimum attendance percentage.
3. A certificate must not already exist for the participant's registration.

The current minimum attendance threshold is **75%**. This is an implementation assumption that should be confirmed with the team if the assignment or agreed business requirements specify a different value.

The attendance percentage and event-completion status are provided to the eligibility service. The Certificates microservice does not currently calculate attendance from individual check-in records.

## Database Model

The `certificates` table contains the following fields:

| Field | Description |
|---|---|
| `id` | UUID identifying the certificate |
| `registration_id` | UUID identifying the participant's registration; unique |
| `file_path` | Relative storage key for the generated PDF |
| `issued_at` | Timestamp indicating when the certificate was issued |

The database stores certificate metadata rather than the PDF contents themselves. The `file_path` column contains a relative storage key, not an absolute filesystem path.

The database schema is managed through Alembic migrations.

## Dependencies

The Python dependencies are listed in `requirements.txt`. They include FastAPI, Uvicorn, SQLAlchemy, Alembic, Pydantic Settings, psycopg, ReportLab, and Pytest. The `httpx` package is used by FastAPI's `TestClient`.

The internal `discovery` library is installed separately from `service-discoverer/Libs/python`.

For local development, run the following commands from the `certificates/` directory:

```powershell
python -m pip install -r requirements.txt
python -m pip install ../service-discoverer/Libs/python
```

To run the tests, see the [Running Tests](#running-tests) section.

The Dockerfile receives the internal library through a named `discovery` build context. Therefore, the `certificates` service in the main Compose file declares `additional_contexts` pointing to `service-discoverer/Libs/python`.

## Configuration

The service uses environment variables for configuration.

### Application settings

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | Not configured | Required database connection URL. |
| `SERVICE_DISCOVERER_URL` | `http://service-discoverer:8080` | Base URL of the service discoverer. |
| `SERVICE_HOST` | Not configured | Optional host announced to the discoverer when registration is enabled. |
| `PORT` | `8080` | Port setting used by the internal discovery library. The current Uvicorn run command explicitly uses port `8080`. |
| `CERTIFICATE_STORAGE_DIR` | `certificate_files` | Directory used to store generated PDF files. |

The database URL should use the `postgresql+psycopg://` driver when connecting to PostgreSQL.

### Docker Compose database settings

The main Compose configuration uses the following variables for the Certificates database:

| Variable | Default | Description |
|---|---|---|
| `CERTIFICATES_DB_USER` | `certificates` | PostgreSQL user for the local Certificates database. |
| `CERTIFICATES_DB_PASSWORD` | Must be configured | Password for the PostgreSQL user. |
| `CERTIFICATES_DATABASE_URL` | Must be configured | Database URL passed to the application as `DATABASE_URL`. |

Configure `CERTIFICATES_DB_PASSWORD` and `CERTIFICATES_DATABASE_URL` in the environment or in a local `.env` file before starting the service with Docker Compose.

The database URL must point to the `certificates` database on the `certificates-db` service and match the configured PostgreSQL credentials. Special characters in credentials must be URL-encoded.

No secrets should be committed to the repository.

The Compose configuration includes PostgreSQL 16 on the private `certificates-net` network, without a published host port and with a persistent database volume. The `service_healthy` condition controls startup order but does not replace the application's database connectivity check.

## Service Discovery

The adapter in `app/integrations/discovery.py` imports `Kind.CERTIFICATES` and `register` from the internal `discovery` library.

The library reads `SERVICE_DISCOVERER_URL`, `SERVICE_HOST`, and `PORT`. However, `register()` is not currently called automatically during application startup.

The current implementation therefore does not register the Certificates service automatically. Before enabling registration, the application should account for discoverer unavailability, retries, and re-registration when necessary.

## API Endpoints

### `GET /healthcheck`

Checks whether the service can connect to its configured database by executing `SELECT 1`.

- **200 OK:** The database is configured and the connectivity check succeeds.
- **503 Service Unavailable:** The database URL is missing or the connection check fails.

Example successful response:

```json
{
  "status": "ok"
}
```

The endpoint does not expose internal database error details in its response.

### `GET /openapi.json`

Returns the OpenAPI specification generated by FastAPI.

**Current limitation:** Public HTTP endpoints for issuing certificates and retrieving certificate PDFs have not yet been implemented. These operations currently exist in the service layer through `CertificateService`.

## Running the Service

### Local development

From the `certificates/` directory, install the dependencies and the internal discovery library as described in the [Dependencies](#dependencies) section.

Start the application with:

```powershell
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

A working database configuration is required for the health check to return `200 OK`.

### Docker Compose

Run these commands from the repository root.

Build the service image:

```powershell
docker compose build certificates
```

Start the service and its configured dependencies in the background:

```powershell
docker compose up -d --build certificates
```

Check the container status:

```powershell
docker compose ps
```

View the service logs:

```powershell
docker compose logs -f certificates
```

Stop the service:

```powershell
docker compose stop certificates
```

Ensure the database environment variables described above are configured before starting the service.

## Running Tests

Run the tests from the `certificates/` directory.

In PowerShell:

```powershell
$env:PYTHONPATH = (Get-Location).Path
python -m pytest
```

The `PYTHONPATH` setting ensures that Python can resolve the `app` package when tests are run from this directory.

The latest recorded test run completed with **34 passed and 1 warning**. The warning concerns a deprecated AnyIO API alias used by Starlette's test client; it did not cause any test failures.

The isolated tests do not require a running PostgreSQL instance when they use in-memory SQLite databases or mock database connectivity. Tests that exercise the actual PostgreSQL integration require an appropriately configured database.

## Current Limitations and Next Steps

The following work remains before the microservice is fully integrated:

- Define request and response schemas for the public certificate API.
- Implement HTTP endpoints for issuing certificates and retrieving PDF files.
- Agree on the integration contract with the Events and Subscriptions microservices, including how participant and event information will be provided.
- Implement inter-service communication or message consumption once the contract has been agreed upon.
- Confirm the minimum attendance threshold with the team.
- Verify authentication and authorization requirements for protected operations.
- Enable and test service discovery registration, including failure handling and retries.
- Verify that generated PDF files persist across container recreation and configure storage appropriately for deployment.
- Expand API and end-to-end integration tests.

## Technology Stack

- Python
- FastAPI
- Uvicorn
- SQLAlchemy
- Alembic
- Pydantic Settings
- psycopg
- ReportLab
- Pytest
- Docker Compose
