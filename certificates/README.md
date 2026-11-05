# Certificates Service

The Certificates microservice is responsible for generating, storing, and retrieving certificates for participants in events. It uses FastAPI, SQLAlchemy, Alembic, and ReportLab.

Certificates are created **only** by consuming Subscription's `AttendanceEligible` events from Kafka (see [ADR-006](../docs/decisions/ADR-006-certificates-issued-from-attendance-events.md)); there is no endpoint to create one. The HTTP API, behind the gateway, lets a participant list and download their own certificates.

## Features

- **Event-driven issuance:** a Kafka consumer (group `certificates-service`) turns `AttendanceEligible` events into certificates, after validating them (contract, consistency, Certificates' own 75% rule) and checking Events and Users instead of trusting the event.
- **Eligibility validation:** A certificate can be issued only after the event has ended and the event attendance percentage (supplied by Subscription and re-verified here) meets the minimum (75%).
- **PDF generation:** Certificates are generated as A4 landscape PDF documents using ReportLab.
- **Pluggable blob storage:** PDFs live outside the database, behind a storage interface with a local-filesystem backend and an S3-compatible backend (SeaweedFS in Compose).
- **Database persistence:** Certificate metadata (including the owner `user_id`, the `event_id` and the `activity_id` of the triggering registration) is stored using SQLAlchemy; Alembic migrations run before the server starts.
- **Duplicate prevention:** There is at most one certificate per registration and **one per (user, event)** (unique indexes), which also makes redelivered events harmless; the first completion wins.
- **Owner-only API:** `GET /api/v1/certificates/me` and `GET /api/v1/certificates/{certificate_id}`; identity comes from the gateway's `X-User-Id` header.
- **Health check:** The service checks database connectivity through `GET /healthcheck` (it does not depend on Kafka or the object store).
- **Service discovery:** The service registers itself with the service discoverer in a background thread at startup.

## Project Structure

```text
certificates/
├── app/
│   ├── api/
│   │   └── routes/
│   │       └── certificates.py
│   ├── integrations/
│   │   ├── directory.py
│   │   ├── discovery.py
│   │   └── topics.py
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
│   ├── consumer.py
│   ├── database.py
│   ├── errors.py
│   ├── main.py
│   ├── migrate.py
│   ├── runtime.py
│   └── security.py
├── migrations/
├── scripts/
│   └── register_gateway.sh
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

The attendance rule (RN06) is about an **event**, not an activity: the percentage is the share of the event's activities the participant attended.

1. The event must have ended (`now(UTC) >= ends_at` of the event, read from Events).
2. The event attendance percentage must be at least **75%** (`MINIMUM_ATTENDANCE_PERCENTAGE` in `app/services/eligibility.py`, Certificates' own rule).
3. A certificate must not already exist for the participant's registration, nor for the pair (user, event).

**Percentage supplied and re-verified:** Subscription computes the percentage over the event's activities and emits `AttendanceEligible` only when its own rule is met, once per user and event, after the last confirmed activity of the event ends. Certificates does not blindly trust it: it validates the contract, checks that `attendance_percentage` equals `round(attended_activities * 100 / total_activities, 2)` (tolerance 0.01) and applies its own 75% threshold through `CertificateService.issue_certificate`. Certificates cannot recount check-ins itself: after the consistency check it trusts the counts.

## Kafka Consumer

The consumer is the only way a certificate is created. It runs in a daemon thread started by the application lifespan and stopped on shutdown; the service boots and serves `/healthcheck` even if Kafka is down.

- **Topic:** `subscription.events` (group `certificates-service`, manual offset commit **after** processing, `topic.metadata.refresh.interval.ms=10000`).
- **Topic provisioning (ADR-005):** before consuming, the service creates `subscription.events` and `certificates.dlq` if absent (replication 1, `CERTIFICATES_TOPIC_PARTITIONS` partitions, existing topics are never altered), retrying with backoff in the background until Kafka is up.
- **Envelope (JSON):** `message_id`, `schema_version` (must be `1`), `type`, `registration_id`, `activity_id`, `user_id`, `aggregate_version`, `occurred_at`, `status`, `trace_id`, plus the event-level fields `parent_event_id` (UUID of the Events event), `attended_activities` and `total_activities` (integers, `total >= 1`, `0 <= attended <= total`) and `attendance_percentage` (finite number, `attended * 100 / total` rounded to 2 decimals). `registration_id` and `activity_id` are those of the triggering registration (the last one to end).
- **Only `type == "AttendanceEligible"` is acted on.** Every other type, including unknown ones, is acknowledged and ignored.

For an `AttendanceEligible` event the service does its own validations before issuing:

1. Contract validation: `parent_event_id` is a UUID; `attended_activities` and `total_activities` are integers (booleans rejected) with `total >= 1` and `0 <= attended <= total`; `attendance_percentage` is a finite number consistent with the counts. A violation is poison (`INVALID_CONTRACT`).
2. If a certificate already exists for `registration_id` or for `(user_id, parent_event_id)`, the event is a duplicate: success, commit, no lookups.
3. `GET /events/{parent_event_id}` on Events (through the discoverer) for `title`, `starts_at`, `ends_at`. `404` is poison (`EVENT_NOT_FOUND`); any other failure is transient.
4. The event must have ended (`now(UTC) >= ends_at`); otherwise nothing is issued and the message is retried later.
5. `GET /internal/users/{user_id}` on Users for the participant name (`200 {"id","name"}`; `404` is poison). This endpoint is unauthenticated and protected by network isolation; it is never registered on the gateway.
6. `CertificateService.issue_certificate` applies the eligibility rule to the validated percentage (below 75% is poison, `NOT_ELIGIBLE`), renders the PDF (event name = event title, date = date of the event's `starts_at` in its own offset), stores it and saves the row.

All outbound calls carry one `X-Trace-Id` per message. Names and payloads are never logged; logs carry ids only.

**Failure handling**

| Outcome | Examples | Action |
|---|---|---|
| Ignored | Any other `type` | Commit. |
| Duplicate | Certificate already exists for the registration or for (user, event), including a lost unique-violation race | Commit. |
| Poison | Malformed JSON, missing or non-UUID ids, invalid or inconsistent attendance fields, `schema_version != 1`, unknown event or user, not eligible (below 75%) | Publish a reference-only record (`source_topic`, `partition`, `offset`, `reason`) to `certificates.dlq`, then commit. |
| Transient | Events/Users unreachable or non-2xx, event not ended yet, storage or database failure, unexpected exception | Do not commit; seek back to the same message and retry after a backoff (2 s doubling to 30 s). The thread never crashes. |

If publishing to the DLQ itself fails, the message is treated as transient.

## Database Model

The `certificates` table contains the following fields:

| Field | Description |
|---|---|
| `id` | UUID identifying the certificate |
| `registration_id` | UUID identifying the participant's registration (the triggering one); unique |
| `user_id` | UUID of the owner (from the event); indexed |
| `activity_id` | UUID of the activity of the triggering registration (from the event) |
| `event_id` | UUID of the Events event (`parent_event_id`); unique together with `user_id` |
| `file_path` | Opaque storage key (`<uuid>.pdf`) of the generated PDF |
| `issued_at` | Timestamp indicating when the certificate was issued |

`user_id` and `activity_id` are nullable in the database only because rows created before migration `7c1d3e9a4b52` cannot be backfilled; `event_id` is nullable for the same reason (migration `9e4a6b2c1d83`, which also adds the unique index `uq_certificates_user_event` on `(user_id, event_id)`; NULLs are distinct, so old rows never collide). Every new certificate sets all three (the repository requires them), and a row without `user_id` belongs to nobody and is never served.

The database stores metadata rather than the PDF contents. `file_path` is a storage key, not a filesystem path, and has the same meaning in both storage backends.

Migrations run with `python -m app.migrate` (`alembic upgrade head`) before Uvicorn starts, as part of the image command. It is idempotent, retries with backoff while the database is unreachable, and exits non-zero if it still fails, so the container fails loudly instead of serving without a schema.

## Blob Storage

`app/services/storage.py` defines the `BlobStorage` interface (`save_pdf`, `read_pdf`, `delete_pdf`) with opaque `<uuid>.pdf` keys that are validated on every call. `get_storage()` is the single factory that picks the backend from `CERTIFICATE_STORAGE_BACKEND`.

| Backend | Value | Notes |
|---|---|---|
| Local filesystem | `local` (code default; used by tests) | Writes under `CERTIFICATE_STORAGE_DIR`. |
| S3-compatible | `s3` (Compose default) | `boto3` with path-style addressing (SeaweedFS), short timeouts and retries. At startup the bucket is created if absent, in the background with backoff; `/healthcheck` does not depend on storage. |

Storage failures are reported as `CertificateStorageError`. A certificate row whose PDF is missing is a server-side fault: the API answers `503` without leaking paths.

## Dependencies

The Python dependencies are listed in `requirements.txt`. They include FastAPI, Uvicorn, SQLAlchemy, Alembic, Pydantic Settings, psycopg, ReportLab, boto3, confluent-kafka, and Pytest. The `httpx` package is used by FastAPI's `TestClient`.

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
| `SERVICE_HOST` | Not configured | Optional host announced to the discoverer. |
| `PORT` | `8080` | Port announced by the internal discovery library. The image command runs Uvicorn on `8080`. |
| `KAFKA_BROKERS` | `kafka:9092` | Kafka bootstrap servers. |
| `SUBSCRIPTION_EVENTS_TOPIC` | `subscription.events` | Topic consumed (group `certificates-service`). |
| `CERTIFICATES_DLQ_TOPIC` | `certificates.dlq` | Topic that receives reference-only records of poison messages. |
| `CERTIFICATES_TOPIC_PARTITIONS` | `6` | Partitions used when the service creates a missing topic (must be > 0). |
| `CERTIFICATE_STORAGE_BACKEND` | `local` | `local` or `s3`. |
| `CERTIFICATE_STORAGE_DIR` | `certificate_files` | Directory used by the `local` backend. |
| `S3_ENDPOINT_URL` | Not configured | S3-compatible endpoint (e.g. `http://certificates-s3:8333`). |
| `S3_BUCKET` | `certificates` | Bucket for the PDFs. |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Not configured | Credentials of the object store. |
| `S3_REGION` | `us-east-1` | Region used to sign requests. |
| `WORKERS_ENABLED` | `true` | Set to `false` to skip the background work (registration, bucket, consumer); used by the tests. |

The database URL should use the `postgresql+psycopg://` driver when connecting to PostgreSQL.

### Docker Compose settings

The main Compose configuration uses the following variables:

| Variable | Default | Description |
|---|---|---|
| `CERTIFICATES_DB_USER` | `certificates` | PostgreSQL user for the local Certificates database. |
| `CERTIFICATES_DB_PASSWORD` | Must be configured | Password for the PostgreSQL user. |
| `CERTIFICATES_DATABASE_URL` | Must be configured | Database URL passed to the application as `DATABASE_URL`. |
| `CERTIFICATES_S3_ACCESS_KEY` | Must be configured | S3 access key (SeaweedFS identity); also passed to the app as `S3_ACCESS_KEY`. |
| `CERTIFICATES_S3_SECRET_KEY` | Must be configured | S3 secret key; also passed to the app as `S3_SECRET_KEY`. |

Configure these in the environment or in a local `.env` file (see `.env.example`) before starting the service with Docker Compose. There are no defaults, so a missing value makes PostgreSQL or the S3 store fail loudly instead of running with a known credential. The database URL must point to the `certificates` database on the `certificates-db` service and match the PostgreSQL credentials; special characters in credentials must be URL-encoded. No secrets should be committed to the repository.

The Compose configuration includes PostgreSQL 16 and SeaweedFS (S3 gateway on port 8333, `certificates-s3`) on the private `certificates-net` network, without published host ports and with persistent volumes (`certificates-db-data`, `certificates-s3-data`). The `certificates` service waits for both and for Kafka to be healthy, but the application still boots and answers `/healthcheck` if Kafka is down. The `service_healthy` condition does not replace the application's own connectivity checks.

## Service Discovery

At startup the lifespan calls `register_service()` (`app/integrations/discovery.py`, built on the internal `discovery` library) in a background thread. `register()` blocks while it retries (about 2.5 minutes), so it never runs on the startup path; a failure is logged. Because the discoverer's registry is in memory, the thread registers again every 30 seconds so a restarted discoverer finds the service again.

The same library is used to call Events (`Kind.EVENTS`) and Users (`Kind.USER`) from the consumer.

## API Endpoints

The service sits behind the gateway. The gateway verifies the JWT and injects `X-User-Id` (UUID) and `X-User-Roles`; Certificates trusts only those headers and never sees the token. A missing or non-UUID `X-User-Id` is answered with `401` and the problem code `UNAUTHENTICATED`.

Errors are `application/problem+json` with `status`, `title`, `code` and `traceId`. `X-Trace-Id` is echoed (a valid inbound value is kept, otherwise one is generated) and is the `traceId`.

### `GET /api/v1/certificates/me?limit=&offset=`

Lists the caller's certificates, newest first. `limit` is 1..100 (default 50) and `offset` is >= 0; invalid values give `400 INVALID_REQUEST`.

```json
{
  "certificates": [
    {
      "id": "…",
      "registration_id": "…",
      "activity_id": "…",
      "event_id": "…",
      "issued_at": "2026-11-04T12:00:00Z"
    }
  ]
}
```

### `GET /api/v1/certificates/{certificate_id}`

Returns `200 application/pdf` with `Content-Disposition: attachment; filename="certificate-<id>.pdf"`, only if the certificate belongs to the caller. A certificate of someone else answers `404 NOT_FOUND`, identical to a nonexistent one (no enumeration). A row whose PDF is missing answers `503 STORAGE_UNAVAILABLE` without leaking paths. A database failure answers `503 DATABASE_UNAVAILABLE`.

There is no endpoint to create a certificate.

### `GET /healthcheck`

Checks whether the service can connect to its configured database by executing `SELECT 1`. It does not depend on Kafka, the discoverer or the object store.

- **200 OK:** `{"status": "ok"}`
- **503 Service Unavailable:** `{"detail": "unhealthy"}` (database not configured or not reachable; no internal details).

### `GET /openapi.json`

Returns the OpenAPI specification, which documents every route with summaries, response models and the 400/401/404/503 problem responses. `/docs` and `/redoc` are disabled.

### Gateway routes

`/healthcheck` and `/openapi.json` are private. After the gateway has synced the `certificates` kind, open only the two business routes (run from the repository root):

```sh
GATEWAY_ADMIN_URL=http://localhost:8080 sh certificates/scripts/register_gateway.sh
```

The script opens the two `GET` routes with `requireAuth` and per-user rate limits. The gateway admin API has no authentication; see the warning in the script.

## Running the Service

### Local development

From the `certificates/` directory, install the dependencies and the internal discovery library as described in the [Dependencies](#dependencies) section.

Start the application with:

```powershell
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

A working database configuration is required for the health check to return `200 OK`. Run `python -m app.migrate` first to apply the migrations; the Docker image does this automatically.

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

The tests use fakes for Kafka, the discoverer, Events/Users and S3 (no network), SQLite for the repository, service and API tests, and a SQLite file for the migration test (PostgreSQL itself is not exercised by the unit tests). A warning about a deprecated AnyIO alias used by Starlette's test client is expected.

## Current Limitations and Next Steps

- The 75% threshold is an implementation assumption to confirm with the team; it is applied both by Subscription and, independently, here.
- Certificates cannot recount check-ins: it trusts `attended_activities`/`total_activities` after the consistency check with the percentage.
- Events must expose `GET /events/{id}` (with `title`, `starts_at`, `ends_at`), and Users `GET /internal/users/{id}`, as described above; they are consumed through the discoverer.
- The event date on the PDF is the date of the event's `starts_at`, in its own offset.
- A message that depends on an unavailable service is retried indefinitely (backoff up to 30 s), which blocks the partition behind it; this favors never losing a certificate over throughput.
- Several replicas are safe for issuance (unique `registration_id` and unique `(user_id, event_id)`), but concurrent migrations at first boot are not serialized.
- The S3 credentials of Compose are shared by SeaweedFS and the application; use a dedicated access key outside development.

## Technology Stack

- Python
- FastAPI
- Uvicorn
- SQLAlchemy
- Alembic
- Pydantic Settings
- psycopg
- ReportLab
- boto3 (S3/SeaweedFS)
- confluent-kafka
- Pytest
- Docker Compose
