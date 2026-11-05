"""Contratos de integração explícitos; os serviços externos ainda precisam implementá-los."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Activity(BaseModel):
    """Resposta confiável de Eventos. Valores monetários são inteiros na menor unidade."""

    model_config = ConfigDict(extra="ignore")
    activity_id: UUID
    event_id: UUID
    capacity: int = Field(ge=0, strict=True)
    amount_minor: int = Field(ge=0, strict=True)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    registration_open: bool
    waitlist_enabled: bool
    starts_at: datetime
    ends_at: datetime

    @model_validator(mode="after")
    def dates(self):
        if self.starts_at.tzinfo is None or self.ends_at.tzinfo is None or self.ends_at <= self.starts_at:
            raise ValueError("Datas devem ter fuso e término posterior ao início")
        return self


class PaymentEvent(BaseModel):
    """Resultado publicado por Pagamentos; campos adicionais são ignorados."""

    model_config = ConfigDict(extra="ignore")
    message_id: UUID
    schema_version: Literal[1]
    type: Literal[
        "PaymentCreated",
        "PaymentApproved",
        "PaymentDeclined",
        "PaymentExpired",
        "PaymentCancelled",
        "PaymentRefunded",
    ]
    registration_id: UUID
    amount_minor: int = Field(ge=0, strict=True)
    currency: str
    # Eco do trace_id que originou o pagamento; nulo/ausente quando a origem foi trabalho de fundo.
    trace_id: str | None = None


class EventsEnvelope(BaseModel):
    """Envelope plano comum a todas as mensagens de `events.events`; o tipo é validado só para os tratados."""

    model_config = ConfigDict(extra="ignore")
    message_id: UUID
    schema_version: Literal[1]
    type: str = Field(min_length=1)


class ActivityEvent(BaseModel):
    """Mensagem de Eventos tratada aqui; os demais tipos de `events.events` são ignorados antes desta validação."""

    model_config = ConfigDict(extra="ignore")
    message_id: UUID
    schema_version: Literal[1]
    type: Literal["ActivityEnded", "ActivityCancelled"]
    activity_id: UUID


class DomainError(Exception):
    """Erro seguro para a API, sem SQL, credenciais ou dados de terceiros."""

    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(code)
