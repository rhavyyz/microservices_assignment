package com.eventhub.users.user;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class UserSpecificationsTest {

    @Test
    void containsWrapsTermAndTreatsWildcardsAsLiterals() {
        assertThat(UserSpecifications.contains("maria")).isEqualTo("%maria%");
        assertThat(UserSpecifications.contains("50%_off")).isEqualTo("%50\\%\\_off%");
        assertThat(UserSpecifications.contains("a\\b")).isEqualTo("%a\\\\b%");
        assertThat(UserSpecifications.contains("%%")).isEqualTo("%\\%\\%%");
    }
}
