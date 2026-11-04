
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=discovery . /opt/discovery
RUN pip install --no-cache-dir /opt/discovery \
    && useradd --system --uid 10001 --no-create-home app

COPY app ./app
COPY alembic.ini .
COPY migrations ./migrations

RUN mkdir -p /var/lib/certificates \
    && chown -R 10001:10001 /app /var/lib/certificates

USER 10001

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
