package com.eventhub.users.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;

import com.eventhub.users.support.Http;
import com.eventhub.users.support.PostgresIT;

import org.junit.jupiter.api.Test;

/** Consulta interna de nome: sem token, somente id e name, e sem abrir mais rotas do que o necessário. */
class InternalUserControllerIT extends PostgresIT {

    private static final String PW = "senha-forte-de-teste-123";

    private String register(String name) {
        String email = "int-" + UUID.randomUUID() + "@example.com";
        Http.Result r = http().post("/api/v1/auth/register",
                "{\"name\":\"" + name + "\",\"email\":\"" + email + "\",\"password\":\"" + PW + "\"}");
        assertThat(r.status()).isEqualTo(201);
        return r.json("$.id");
    }

    @Test
    void returnsExactlyIdAndNameWithoutAuthorization() {
        String id = register("Mariana Costa");
        Http.Result r = http().get("/internal/users/" + id, null);
        assertThat(r.status()).isEqualTo(200);
        Map<String, Object> body = r.json("$");
        assertThat(body.keySet()).containsExactlyInAnyOrder("id", "name");
        assertThat(body).containsEntry("id", id).containsEntry("name", "Mariana Costa");
    }

    @Test
    void neverLeaksEmailRolesOrPassword() {
        String id = register("Joao Silva");
        String body = http().get("/internal/users/" + id, null).body().toLowerCase();
        assertThat(body).doesNotContain("email").doesNotContain("roles").doesNotContain("password")
                .doesNotContain("hash").doesNotContain("status").doesNotContain("@");
    }

    @Test
    void unknownIdIsProblemJson404() {
        Http.Result r = http().get("/internal/users/" + UUID.randomUUID(), null);
        assertThat(r.status()).isEqualTo(404);
        assertThat(r.header("Content-Type")).startsWith("application/problem+json");
        assertThat(r.<String>json("$.code")).isEqualTo("NOT_FOUND");
    }

    @Test
    void nonUuidIsCleanProblemJson400() {
        Http.Result r = http().get("/internal/users/not-a-uuid", null);
        assertThat(r.status()).isEqualTo(400);
        assertThat(r.header("Content-Type")).startsWith("application/problem+json");
        assertThat(r.<String>json("$.code")).isEqualTo("VALIDATION_ERROR");
        assertThat(r.body()).doesNotContain("Exception").doesNotContain("not-a-uuid");
    }

    @Test
    void permitRuleIsNotBroaderThanTheLookup() {
        assertThat(http().get("/api/v1/users/me", null).status()).isEqualTo(401);
        assertThat(http().get("/api/v1/users", null).status()).isEqualTo(401);
        assertThat(http().get("/internal/anything-else", null).status()).isEqualTo(401);
        assertThat(http().get("/internal/users", null).status()).isEqualTo(401);
        assertThat(http().get("/internal/users/" + UUID.randomUUID() + "/extra", null).status()).isEqualTo(401);
        assertThat(http().send("DELETE", "/internal/users/" + UUID.randomUUID(), null, null).status())
                .isEqualTo(401);
    }
}
