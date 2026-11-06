FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY --from=discovery . /opt/discovery
RUN pip install --no-cache-dir /opt/discovery

COPY app ./app
RUN useradd --create-home --uid 10001 subscription
USER subscription
EXPOSE 8080
CMD ["python", "-m", "app"]
