package com.eventhub.users.user;

import static org.assertj.core.api.Assertions.assertThat;

import com.eventhub.users.support.PostgresIT;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/** Configuração padrão de teste (sem ativar o seed): nenhuma conta ORGANIZER pode existir. */
class NoSeedByDefaultIT extends PostgresIT {

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void noOrganizerExistsUnlessSeedIsExplicitlyEnabled() {
        var r = http().post("/api/v1/auth/register",
                "{\"name\":\"Maria\",\"email\":\"padrao-" + System.nanoTime() + "@example.com\",\"password\":\"senha-forte-123\"}");
        assertThat(r.status()).isEqualTo(201);
        assertThat(jdbc.queryForObject(
                "select count(*) from user_roles ur join users u on u.id = ur.user_id where ur.role = 'ORGANIZER' and u.email not like 'organizador@%'",
                Integer.class)).isZero();
    }
}
