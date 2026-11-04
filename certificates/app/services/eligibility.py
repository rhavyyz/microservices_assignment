
from decimal import Decimal, InvalidOperation


MINIMUM_ATTENDANCE_PERCENTAGE = Decimal("75")


def is_eligible(
    *,
    event_ended: bool,
    attendance_percentage: Decimal | int | float | str,
) -> bool:
    """Apply RN06 to the attendance percentage calculated by the responsible service."""

    if not isinstance(event_ended, bool):
        raise ValueError("event_ended must be a boolean")

    try:
        percentage = Decimal(str(attendance_percentage))
    except (InvalidOperation, ValueError):
        raise ValueError("Invalid attendance percentage") from None

    if (
        not percentage.is_finite()
        or not Decimal("0") <= percentage <= Decimal("100")
    ):
        raise ValueError(
            "Attendance percentage must be between 0 and 100"
        )

    return (
        event_ended
        and percentage >= MINIMUM_ATTENDANCE_PERCENTAGE
    )
