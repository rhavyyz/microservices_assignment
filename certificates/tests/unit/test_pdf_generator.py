
from datetime import date

import pytest

from app.services.pdf_generator import generate_certificate_pdf


def test_generates_valid_pdf_bytes():
    result = generate_certificate_pdf(
        participant_name="Alex Johnson",
        event_name="Software Engineering Workshop",
        event_date=date(2026, 10, 20),
    )

    assert isinstance(result, bytes)
    assert result.startswith(b"%PDF-")
    assert len(result) > 0


def test_rejects_empty_participant_name():
    with pytest.raises(ValueError, match="Participant name"):
        generate_certificate_pdf(
            participant_name=" ",
            event_name="Software Engineering Workshop",
            event_date=date(2026, 10, 20),
        )


def test_rejects_empty_event_name():
    with pytest.raises(ValueError, match="Event name"):
        generate_certificate_pdf(
            participant_name="Alex Johnson",
            event_name=" ",
            event_date=date(2026, 10, 20),
        )
