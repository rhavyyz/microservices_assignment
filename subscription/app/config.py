"""Configuração por ambiente; segredos não possuem valores de desenvolvimento implícitos."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    brokers: str = "kafka:9092"
    discoverer_url: str = "http://service-discoverer:8080"
    service_host: str = ""
    service_token: str = ""
    jwt_issuer: str = "eventhub-users"
    jwks_url: str = ""
    payment_topic: str = "payments.events"
    payment_commands: str = "payments.commands"
    events_topic: str = "events.events"
    domain_topic: str = "subscription.events"
    notifications_topic: str = "notifications"
    dlq_topic: str = "subscription.dlq"
    reservation_seconds: int = 900
    offer_seconds: int = 600
    reconcile_seconds: int = 60
    workers_enabled: bool = True

    @classmethod
    def from_env(cls):
        url = os.environ.get("SUBSCRIPTION_DATABASE_URL", "")
        if not url:
            raise ValueError("SUBSCRIPTION_DATABASE_URL é obrigatório")
        settings = cls(
            database_url=url,
            brokers=os.getenv("KAFKA_BROKERS", "kafka:9092"),
            discoverer_url=os.getenv("SERVICE_DISCOVERER_URL", "http://service-discoverer:8080"),
            service_host=os.getenv("SERVICE_HOST", ""),
            service_token=os.getenv("SUBSCRIPTION_SERVICE_TOKEN", ""),
            jwt_issuer=os.getenv("USERS_JWT_ISSUER", "eventhub-users"),
            jwks_url=os.getenv("USERS_JWKS_URL", ""),
            reservation_seconds=int(os.getenv("RESERVATION_SECONDS", "900")),
            offer_seconds=int(os.getenv("OFFER_SECONDS", "600")),
            reconcile_seconds=int(os.getenv("RECONCILE_SECONDS", "60")),
            workers_enabled=os.getenv("WORKERS_ENABLED", "true").lower() == "true",
            payment_topic=os.getenv("PAYMENT_EVENTS_TOPIC", "payments.events"),
            payment_commands=os.getenv("PAYMENT_COMMANDS_TOPIC", "payments.commands"),
            events_topic=os.getenv("EVENTS_TOPIC", "events.events"),
            domain_topic=os.getenv("SUBSCRIPTION_EVENTS_TOPIC", "subscription.events"),
            notifications_topic=os.getenv("NOTIFICATIONS_TOPIC", "notifications"),
            dlq_topic=os.getenv("SUBSCRIPTION_DLQ_TOPIC", "subscription.dlq"),
        )
        if min(settings.reservation_seconds, settings.offer_seconds, settings.reconcile_seconds) <= 0:
            raise ValueError("Os prazos devem ser positivos")
        return settings
