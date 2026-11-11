package com.eventhub.users.user;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;

import com.eventhub.users.support.PostgresIT;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

/** O primeiro administrador só existe quando ativado por configuração; o cadastro público não pode tomar o e-mail. */
@TestPropertySource(properties = {
        "users.admin-bootstrap.enabled=true",
        "users.admin-bootstrap.name=Administrador de Teste",
        "users.admin-bootstrap.email=Admin-Bootstrap@Example.Test",
        "users.admin-bootstrap.password=senha-de-admin-do-teste-1" })
class AdminBootstrapIT extends PostgresIT {

    @Test
    void bootstrappedAdminCanLoginWithOnlyTheAdminRoleAndTheEmailIsTaken() {
        var login = http().post("/api/v1/auth/login",
                "{\"email\":\"admin-bootstrap@example.test\",\"password\":\"senha-de-admin-do-teste-1\"}");
        assertThat(login.status()).isEqualTo(200);
        assertThat(login.<List<String>>json("$.user.roles")).containsExactly("ADMIN");

        var dup = http().post("/api/v1/auth/register",
                "{\"name\":\"Impostor\",\"email\":\"admin-bootstrap@example.test\",\"password\":\"outra-senha-123456\"}");
        assertThat(dup.status()).isEqualTo(409);

        String token = login.json("$.accessToken");
        assertThat(http().get("/api/v1/admin/users", token).status()).isEqualTo(200);
    }
}
