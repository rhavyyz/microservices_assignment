package com.eventhub.users.user;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;

import com.eventhub.users.support.PostgresIT;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

/** O organizador de demonstração só existe quando ativado por configuração; o cadastro público não o cria. */
@TestPropertySource(properties = {
        "users.dev-seed.enabled=true",
        "users.dev-seed.name=Organizador de Teste",
        "users.dev-seed.email=Organizador@Example.Test",
        "users.dev-seed.password=senha-de-teste-do-seed-1" })
class DevSeedIT extends PostgresIT {

    @Test
    void seededOrganizerCanLoginWithOrganizerRoleAndEmailIsTakenForPublicRegistration() {
        var login = http().post("/api/v1/auth/login",
                "{\"email\":\"organizador@example.test\",\"password\":\"senha-de-teste-do-seed-1\"}");
        assertThat(login.status()).isEqualTo(200);
        assertThat(login.<List<String>>json("$.user.roles")).containsExactly("PARTICIPANT", "ORGANIZER");

        var dup = http().post("/api/v1/auth/register",
                "{\"name\":\"Impostor\",\"email\":\"organizador@example.test\",\"password\":\"outra-senha-123456\"}");
        assertThat(dup.status()).isEqualTo(409);
    }
}
