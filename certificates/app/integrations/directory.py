"""Lookups the consumer makes before issuing a certificate (Events and Users, through the discoverer).

The event is not trusted on its own: the event (title and dates) and the participant's name are
fetched from their owners. Nothing here logs response bodies (the name is personal data).
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from discovery import Kind, request


class PoisonMessage(Exception):
    """The message can never be processed (retrying will not help): send it to the DLQ and move on."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


class TransientError(Exception):
    """A dependency failed or is not ready: do not commit, retry the same message later."""


@dataclass(frozen=True)
class Event:
    id: uuid.UUID
    title: str
    starts_at: datetime
    ends_at: datetime


def _get_json(kind: Kind, path: str, request_id: str, *, missing_reason: str | None) -> dict | None:
    """GET and decode a JSON object. 404 is poison (or None when `missing_reason` is None); anything else is transient."""
    try:
        response = request("GET", kind, path, {"headers": {"X-Request-Id": request_id}})
    except Exception as exc:  # transport errors, discoverer unavailable
        raise TransientError(f"{kind.value} unreachable ({type(exc).__name__})") from None

    if response.status == 404:
        if missing_reason is None:
            return None
        raise PoisonMessage(missing_reason)
    if not 200 <= response.status < 300:
        raise TransientError(f"{kind.value} answered {response.status}")

    try:
        body = response.json()
    except ValueError:
        raise TransientError(f"{kind.value} answered a non-JSON body") from None
    if not isinstance(body, dict):
        raise TransientError(f"{kind.value} answered an unexpected body")
    return body


def _aware(value: object) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp without timezone")
    return parsed


class Directory:
    """Thin client for the other services. Tests replace it with a fake."""

    def get_event(self, event_id: uuid.UUID, request_id: str) -> Event:
        body = _get_json(Kind.EVENTS, f"/events/{event_id}", request_id, missing_reason="EVENT_NOT_FOUND")
        try:
            title = body["title"]
            if not isinstance(title, str) or not title.strip():
                raise ValueError("invalid title")
            return Event(
                id=uuid.UUID(str(body["id"])),
                title=title,
                starts_at=_aware(body["starts_at"]),
                ends_at=_aware(body["ends_at"]),
            )
        except (KeyError, ValueError):
            raise TransientError("events answered an invalid event") from None

    def get_participant_name(self, user_id: uuid.UUID, request_id: str) -> str:
        body = _get_json(Kind.USER, f"/internal/users/{user_id}", request_id, missing_reason="USER_NOT_FOUND")
        name = body.get("name")
        if not isinstance(name, str) or not name.strip():
            raise TransientError("user answered an invalid user")
        return name
