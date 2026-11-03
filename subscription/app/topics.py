"""Criação idempotente dos tópicos usados pelo serviço, antes de consumir ou produzir."""

from confluent_kafka import KafkaError, KafkaException
from confluent_kafka.admin import AdminClient, NewTopic


def ensure_topics(brokers, topics, partitions, admin_factory=None, timeout=15):
    """Cria os tópicos ausentes. Tópicos existentes nunca são alterados: mudar partições remapeia chaves."""
    names = list(dict.fromkeys(topics))
    if not names:
        return
    factory = admin_factory or AdminClient
    admin = factory({"bootstrap.servers": brokers})
    futures = admin.create_topics(
        [NewTopic(name, num_partitions=partitions, replication_factor=1) for name in names],
        request_timeout=timeout,
        operation_timeout=timeout,
    )
    for future in futures.values():
        try:
            future.result(timeout)
        except KafkaException as exc:
            error = exc.args[0] if exc.args else None
            if not (isinstance(error, KafkaError) and error.code() == KafkaError.TOPIC_ALREADY_EXISTS):
                raise
