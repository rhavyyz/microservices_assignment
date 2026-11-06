"""Configuração por ambiente; segredos não possuem valores de desenvolvimento implícitos."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    brokers: str = "kafka:9092"
    payment_topic: str = "payments.events"
    events_topic: str = "events.events"
    domain_topic: str = "subscription.events"
    notifications_topic: str = "notifications"
    dlq_topic: str = "subscription.dlq"
    reservation_seconds: int = 900
    offer_seconds: int = 600
    workers_enabled: bool = True
    kafka_topic_partitions: int = 6
    attendance_min_percent: float = 75.0

    @classmethod
    def from_env(cls):
        url = os.environ.get("SUBSCRIPTION_DATABASE_URL", "")
        if not url:
            raise ValueError("SUBSCRIPTION_DATABASE_URL é obrigatório")
        try:
            partitions = int(os.getenv("SUBSCRIPTION_TOPIC_PARTITIONS", "6"))
        except ValueError:
            raise ValueError("SUBSCRIPTION_TOPIC_PARTITIONS deve ser um inteiro pelo menos 1") from None
        try:
            min_percent = float(os.getenv("ATTENDANCE_MIN_PERCENT", "75"))
        except ValueError:
            raise ValueError("ATTENDANCE_MIN_PERCENT deve ser um número maior que 0 e até 100") from None
        settings = cls(
            database_url=url,
            brokers=os.getenv("KAFKA_BROKERS", "kafka:9092"),
            reservation_seconds=int(os.getenv("RESERVATION_SECONDS", "900")),
            offer_seconds=int(os.getenv("OFFER_SECONDS", "600")),
            workers_enabled=os.getenv("WORKERS_ENABLED", "true").lower() == "true",
            payment_topic=os.getenv("PAYMENT_EVENTS_TOPIC", "payments.events"),
            events_topic=os.getenv("EVENTS_TOPIC", "events.events"),
            domain_topic=os.getenv("SUBSCRIPTION_EVENTS_TOPIC", "subscription.events"),
            notifications_topic=os.getenv("NOTIFICATIONS_TOPIC", "notifications"),
            dlq_topic=os.getenv("SUBSCRIPTION_DLQ_TOPIC", "subscription.dlq"),
            kafka_topic_partitions=partitions,
            attendance_min_percent=min_percent,
        )
        if min(settings.reservation_seconds, settings.offer_seconds) <= 0:
            raise ValueError("Os prazos devem ser positivos")
        if settings.kafka_topic_partitions < 1:
            raise ValueError("SUBSCRIPTION_TOPIC_PARTITIONS deve ser pelo menos 1")
        if not 0 < settings.attendance_min_percent <= 100:
            raise ValueError("ATTENDANCE_MIN_PERCENT deve ser um número maior que 0 e até 100")
        return settings
