package com.microservices.discovery;

/** Service kinds. Gateway and service-discoverer are not part of it. */
public enum Kind {
    CERTIFICATES("certificates"),
    EVENTS("events"),
    SUBSCRIPTION("subscription"),
    PAYMENTS("payments"),
    USER("user"),
    NOTIFICATIONS("notifications"),
    REPORTS("reports");

    private final String value;

    Kind(String value) {
        this.value = value;
    }

    public String value() {
        return value;
    }
}
