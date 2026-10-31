package com.eventhub.users.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Set;

import com.eventhub.users.web.dto.RegisterRequest;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;

import org.junit.jupiter.api.Test;

class RegisterRequestValidationTest {

    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
    private static final String PW = "senha-forte-123";

    private Set<ConstraintViolation<RegisterRequest>> check(String n, String e, String p) {
        return validator.validate(new RegisterRequest(n, e, p));
    }

    @Test
    void acceptsValidInputIncludingPaddedMixedCaseEmail() {
        assertThat(check("Mariana Costa", "  Mariana@Example.com ", PW)).isEmpty();
    }

    @Test
    void rejectsBlankFields() {
        assertThat(check("", "", "")).isNotEmpty();
        assertThat(check(null, null, null)).hasSize(3);
    }

    @Test
    void rejectsMalformedEmails() {
        for (String bad : new String[] { "sem-arroba", "a@b", "a@@b.com", "a b@c.com", "@x.com", "a@.com" }) {
            assertThat(check("Maria", bad, PW)).as(bad).isNotEmpty();
        }
    }

    @Test
    void enforcesPasswordLengthPolicy() {
        assertThat(check("Maria", "m@x.com", "curta")).isNotEmpty();
        assertThat(check("Maria", "m@x.com", "x".repeat(73))).isNotEmpty();
        assertThat(check("Maria", "m@x.com", "x".repeat(10))).isEmpty();
    }

    @Test
    void toStringNeverShowsPassword() {
        assertThat(new RegisterRequest("Maria", "m@x.com", PW).toString()).doesNotContain(PW);
    }
}
