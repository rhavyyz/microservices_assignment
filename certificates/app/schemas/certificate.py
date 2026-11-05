import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class CertificateSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    registration_id: uuid.UUID
    activity_id: uuid.UUID
    issued_at: datetime


class CertificateList(BaseModel):
    certificates: list[CertificateSummary]


class HealthStatus(BaseModel):
    status: str
