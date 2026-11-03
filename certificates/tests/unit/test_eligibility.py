
import pytest

from app.services.eligibility import is_eligible


@pytest.mark.parametrize(
    ("event_ended", "percentage", "expected"),
    [
        (False, 100, False),
        (True, 0, False),
        (True, 74.99, False),
        (True, 75, True),
        (True, 75.01, True),
        (True, 100, True),
    ],
)
def test_rn06_eligibility(event_ended, percentage, expected):
    assert is_eligible(
        event_ended=event_ended,
        attendance_percentage=percentage,
    ) is expected


@pytest.mark.parametrize(
    "percentage",
    [-1, 100.01, float("nan"), float("inf")],
)
def test_rejects_invalid_percentage(percentage):
    with pytest.raises(ValueError):
        is_eligible(
            event_ended=True,
            attendance_percentage=percentage,
        )


def test_rejects_non_boolean_event_status():
    with pytest.raises(ValueError):
        is_eligible(
            event_ended=1,
            attendance_percentage=80,
        )
