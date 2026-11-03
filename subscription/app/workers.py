"""Entrega pelo menos uma vez, recuperação e manutenção sem depender de memória local."""

import json
import logging
import threading

from confluent_kafka import Consumer, Producer
from pydantic import ValidationError

from .contracts import ActivityEvent, DomainError, PaymentEvent
from .topics import ensure_topics

log = logging.getLogger(__name__)


class Workers:
    def __init__(self, db, service, services, settings):
        self.db, self.service, self.services, self.settings = db, service, services, settings
        self.stop = threading.Event()
        self.topics_ready = threading.Event()
        self.threads = []

    def start(self):
        for target in (self.ensure, self.publish, self.consume, self.maintain, self.reconcile, self.register):
            thread = threading.Thread(target=target, name=target.__name__, daemon=True)
            thread.start()
            self.threads.append(thread)

    def close(self):
        self.stop.set()
        for thread in self.threads:
            thread.join(timeout=15)

    def topic_names(self):
        s = self.settings
        return [s.payment_topic, s.payment_commands, s.events_topic, s.domain_topic, s.notifications_topic, s.dlq_topic]

    def ensure(self):
        # Tópicos novos só são vistos pelo librdkafka após o refresh de metadados; criá-los antes evita a espera.
        delay = 2
        while not self.stop.is_set():
            try:
                ensure_topics(self.settings.brokers, self.topic_names(), self.settings.kafka_topic_partitions)
            except Exception:
                log.warning("kafka_topics_ensure_failed")
                self.stop.wait(delay)
                delay = min(delay * 2, 30)
                continue
            log.info("kafka_topics_ready")
            self.topics_ready.set()
            return

    def wait_topics(self):
        while not self.topics_ready.is_set():
            if self.stop.wait(0.2):
                return False
        return True

    def register(self):
        # O registry é volátil; repetir registro recupera reinícios do discoverer.
        while not self.stop.is_set():
            try:
                self.services.register()
            except Exception:
                log.warning("discovery_registration_failed")
            self.stop.wait(30)

    @staticmethod
    def deliver(producer, topic, key, payload):
        result = []
        producer.produce(
            topic,
            key=key,
            value=json.dumps(payload, default=str).encode(),
            on_delivery=lambda error, message: result.append(error),
        )
        pending = producer.flush(6)
        if pending or not result or result[0] is not None:
            raise RuntimeError("Kafka não confirmou a entrega")

    def publish_once(self, producer):
        # Um publicador por banco preserva a ordem entre réplicas. O lock de sessão
        # não mantém transação de negócio aberta durante a publicação na rede.
        with self.db.pool.connection() as conn:
            locked = conn.execute("SELECT pg_try_advisory_lock(731906422) AS acquired").fetchone()["acquired"]
            if not locked:
                return False
            try:
                row = conn.execute(
                    "SELECT * FROM outbox WHERE published_at IS NULL ORDER BY sequence LIMIT 1"
                ).fetchone()
                if not row:
                    return False
                self.deliver(producer, row["topic"], row["message_key"], row["payload"])
                # Queda após entrega gera repetição com o mesmo ID, nunca perda silenciosa.
                conn.execute(
                    "UPDATE outbox SET published_at=clock_timestamp() WHERE sequence=%s", (row["sequence"],)
                )
                return True
            finally:
                conn.execute("SELECT pg_advisory_unlock(731906422)")

    def publish(self):
        if not self.wait_topics():
            return
        producer = Producer(
            {
                "bootstrap.servers": self.settings.brokers,
                "enable.idempotence": True,
                "acks": "all",
                "delivery.timeout.ms": 5000,
            }
        )
        while not self.stop.is_set():
            try:
                if not self.publish_once(producer):
                    self.stop.wait(0.5)
            except Exception:
                log.warning("outbox_delivery_failed")
                self.stop.wait(2)
        producer.flush(6)

    def process(self, topic, payload):
        if topic == self.settings.payment_topic:
            self.service.payment_event(PaymentEvent.model_validate(payload))
        elif topic == self.settings.events_topic:
            event = ActivityEvent.model_validate(payload)
            activity = self.services.activity(event.activity_id)
            self.service.activity_event(event, activity)
        else:
            raise ValueError("Tópico inesperado")

    def quarantine(self, message, reason):
        # Referência para recuperação manual; não copiar dados pessoais para logs/DLQ.
        with self.db.transaction() as conn:
            self.service.enqueue(
                conn,
                self.settings.dlq_topic,
                f"{message.topic()}:{message.partition()}",
                {
                    "source_topic": message.topic(),
                    "partition": message.partition(),
                    "offset": message.offset(),
                    "reason": reason,
                },
            )

    def consume(self):
        config = {
            "bootstrap.servers": self.settings.brokers,
            "group.id": "subscription-service",
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
            "enable.auto.offset.store": False,
            "max.poll.interval.ms": 300000,
            "topic.metadata.refresh.interval.ms": 10000,
        }
        if not self.wait_topics():
            return
        while not self.stop.is_set():
            consumer = Consumer(config)
            try:
                consumer.subscribe([self.settings.payment_topic, self.settings.events_topic])
                while not self.stop.is_set():
                    message = consumer.poll(1)
                    if message is None:
                        continue
                    if message.error():
                        log.warning("kafka_poll_failed")
                        self.stop.wait(2)
                        continue
                    try:
                        self.process(message.topic(), json.loads(message.value()))
                    except (ValidationError, ValueError, UnicodeError, TypeError):
                        self.quarantine(message, "INVALID_CONTRACT")
                    except DomainError as exc:
                        if exc.status >= 500 or exc.code == "ACTIVITY_NOT_ENDED":
                            raise
                        self.quarantine(message, exc.code)
                    consumer.commit(message=message, asynchronous=False)
            except Exception:
                log.warning("kafka_processing_failed")
                # Não confirmar mensagens posteriores por cima da que falhou.
                # Recriar consumidor retoma no último offset confirmado após rebalance.
                self.stop.wait(2)
            finally:
                consumer.close()

    def maintain(self):
        """Expiração não espera pelas consultas HTTP de reconciliação financeira."""
        while not self.stop.is_set():
            try:
                self.service.expire()
            except Exception:
                log.warning("expiration_failed")
            self.stop.wait(2)

    def reconcile(self):
        while not self.stop.is_set():
            try:
                for attempt in self.service.reconciliation_candidates():
                    if self.stop.is_set():
                        break
                    try:
                        self.service.reconcile(attempt["id"], self.services.payment(attempt["id"]))
                    except Exception:
                        log.warning("payment_reconciliation_failed", extra={"attempt_id": str(attempt["id"])})
            except Exception:
                log.warning("reconciliation_failed")
            self.stop.wait(self.settings.reconcile_seconds)
