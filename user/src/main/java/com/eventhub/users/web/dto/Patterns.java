package com.eventhub.users.web.dto;

/** Política de e-mail: ASCII, com tolerância a espaços nas pontas (removidos na normalização). */
final class Patterns {

    static final String EMAIL = "^\\s*[A-Za-z0-9._%+\\-]+@[A-Za-z0-9\\-]+(\\.[A-Za-z0-9\\-]+)+\\s*$";

    private Patterns() {
    }
}
