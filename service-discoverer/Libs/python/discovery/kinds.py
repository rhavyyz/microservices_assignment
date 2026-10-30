from enum import Enum


class Kind(str, Enum):
    """Service kinds. Gateway and service-discoverer are not part of it."""

    CERTIFICATES = "certificates"
    EVENTS = "events"
    SUBSCRIPTION = "subscription"
    PAYMENTS = "payments"
    USER = "user"
    NOTIFICATIONS = "notifications"
    REPORTS = "reports"
