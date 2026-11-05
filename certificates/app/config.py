
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(case_sensitive=False)

    database_url: str | None = None
    service_discoverer_url: str = "http://service-discoverer:8080"
    service_host: str | None = None
    port: int = 8080
    certificate_storage_dir: str = "certificate_files"

    # Blob storage: "local" (filesystem, default for development and tests) or "s3" (S3-compatible, e.g. SeaweedFS).
    certificate_storage_backend: str = "local"
    s3_endpoint_url: str | None = None
    s3_bucket: str = "certificates"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"

    # Kafka: the consumer of Subscription's events is the only way a certificate gets created.
    kafka_brokers: str = "kafka:9092"
    subscription_events_topic: str = "subscription.events"
    certificates_dlq_topic: str = "certificates.dlq"
    certificates_topic_partitions: int = Field(default=6, gt=0)

    # Background work (discovery registration, bucket, Kafka consumer); tests turn it off.
    workers_enabled: bool = True


settings = Settings()
