package com.eventhub.users.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;

import com.eventhub.users.support.Http;
import com.eventhub.users.support.PostgresIT;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Fluxo do pedido de organizador (DT-11): cadastro com "organizador" só abre um pedido; a listagem e a decisão
 * são do ADMIN; o papel só vale no token depois de um novo login.
 */
class AdminFlowIT extends PostgresIT {

    private static final String PW = "senha-forte-de-teste-123";

    @Autowired
    JdbcTemplate jdbc;

    private String tag() {
        return UUID.randomUUID().toString().substring(0, 8);
    }

    private Http.Result register(String name, String email, String requestedRole) {
        String role = requestedRole == null ? "" : ",\"requestedRole\":\"" + requestedRole + "\"";
        return http().post("/api/v1/auth/register",
                "{\"name\":\"" + name + "\",\"email\":\"" + email + "\",\"password\":\"" + PW + "\"" + role + "}");
    }

    private String login(String email) {
        return http().post("/api/v1/auth/login", "{\"email\":\"" + email + "\",\"password\":\"" + PW + "\"}")
                .json("$.accessToken");
    }

    /** Cria um ADMIN direto no banco: nenhuma rota HTTP concede esse papel. */
    private String adminToken(String tag) {
        String email = "admin-" + tag + "@example.com";
        String id = register("Admin " + tag, email, null).json("$.id");
        jdbc.update("delete from user_roles where user_id = ?::uuid", id);
        jdbc.update("insert into user_roles (user_id, role) values (?::uuid, 'ADMIN')", id);
        return login(email);
    }

    @Test
    void registeringAsOrganizerOnlyOpensAPendingRequest() {
        String tag = tag();
        Http.Result r = register("Olga " + tag, "olga-" + tag + "@example.com", "ORGANIZER");
        assertThat(r.status()).isEqualTo(201);
        assertThat(r.<List<String>>json("$.roles")).containsExactly("PARTICIPANT");
        assertThat(r.<String>json("$.organizerRequest")).isEqualTo("PENDING");

        String token = login("olga-" + tag + "@example.com");
        assertThat(http().get("/api/v1/users?name=" + "Ol", token).status()).isEqualTo(403);
        assertThat(http().get("/api/v1/users/me", token).<String>json("$.organizerRequest")).isEqualTo("PENDING");
    }

    @Test
    void participantChoiceAndNoChoiceHaveNoRequest() {
        String tag = tag();
        assertThat(register("Pedro " + tag, "pedro-" + tag + "@example.com", "PARTICIPANT")
                .<String>json("$.organizerRequest")).isEqualTo("NONE");
        assertThat(register("Paula " + tag, "paula-" + tag + "@example.com", null)
                .<String>json("$.organizerRequest")).isEqualTo("NONE");
    }

    @Test
    void registrationCannotAskForAdminOrAnUnknownRole() {
        String tag = tag();
        assertThat(register("Mal " + tag, "mal-" + tag + "@example.com", "ADMIN").status()).isEqualTo(400);
        assertThat(register("Mal " + tag, "mal2-" + tag + "@example.com", "DONO").status()).isEqualTo(400);
        assertThat(http().post("/api/v1/auth/register", "{\"name\":\"Mal\",\"email\":\"mal3-" + tag
                + "@example.com\",\"password\":\"" + PW + "\",\"roles\":[\"ADMIN\"]}").status()).isEqualTo(400);
    }

    @Test
    void adminRoutesRejectEveryoneWhoIsNotAdmin() {
        String tag = tag();
        String id = register("Org " + tag, "org-" + tag + "@example.com", "ORGANIZER").json("$.id");
        jdbc.update("insert into user_roles (user_id, role) values (?::uuid, 'ORGANIZER')", id);
        String orgToken = login("org-" + tag + "@example.com");

        try {
            assertThat(http().get("/api/v1/admin/users", null).status()).isEqualTo(401);
            assertThat(http().get("/api/v1/admin/users", orgToken).status()).isEqualTo(403);
            assertThat(http().send("PUT", "/api/v1/admin/users/" + id + "/organizer", "{\"approved\":true}",
                    orgToken).status()).isEqualTo(403);
        } finally {
            // NoSeedByDefaultIT exige que nenhum ORGANIZER sobre no banco compartilhado
            jdbc.update("delete from user_roles where user_id = ?::uuid and role = 'ORGANIZER'", id);
        }
    }

    @Test
    void adminListsEveryoneAndFiltersPendingRequests() {
        String tag = tag();
        String admin = adminToken(tag);
        register("Pendente " + tag, "pend-" + tag + "@example.com", "ORGANIZER");
        register("Comum " + tag, "comum-" + tag + "@example.com", null);

        Http.Result all = http().get("/api/v1/admin/users?q=" + tag, admin);
        assertThat(all.status()).isEqualTo(200);
        assertThat(all.<List<Object>>json("$.items")).hasSize(3); // admin, pendente e comum têm o marcador no nome/e-mail

        Http.Result pending = http().get("/api/v1/admin/users?q=" + tag + "&organizerRequest=PENDING", admin);
        assertThat(pending.<List<Object>>json("$.items")).hasSize(1);
        assertThat(pending.<String>json("$.items[0].email")).isEqualTo("pend-" + tag + "@example.com");
        assertThat(pending.body()).doesNotContain("passwordHash").doesNotContain("password_hash");

        assertThat(http().get("/api/v1/admin/users?organizerRequest=TALVEZ", admin).status()).isEqualTo(400);
        assertThat(http().get("/api/v1/admin/users?size=51", admin).status()).isEqualTo(400);
    }

    @Test
    void approvalGrantsOrganizerOnlyAfterANewLoginAndDenialTakesItAway() {
        String tag = tag();
        String admin = adminToken(tag);
        String email = "cand-" + tag + "@example.com";
        String id = register("Candidata " + tag, email, "ORGANIZER").json("$.id");
        String oldToken = login(email);

        Http.Result approved = http().send("PUT", "/api/v1/admin/users/" + id + "/organizer",
                "{\"approved\":true}", admin);
        assertThat(approved.status()).isEqualTo(200);
        assertThat(approved.<List<String>>json("$.roles")).containsExactly("PARTICIPANT", "ORGANIZER");
        assertThat(approved.<String>json("$.organizerRequest")).isEqualTo("APPROVED");

        // o token antigo ainda diz só PARTICIPANT; o novo login traz ORGANIZER
        assertThat(http().get("/api/v1/users?name=Ca", oldToken).status()).isEqualTo(403);
        String newToken = login(email);
        assertThat(http().get("/api/v1/users?name=Ca", newToken).status()).isEqualTo(200);
        assertThat(http().get("/api/v1/users/me", newToken).<List<String>>json("$.roles"))
                .containsExactly("PARTICIPANT", "ORGANIZER");

        Http.Result denied = http().send("PUT", "/api/v1/admin/users/" + id + "/organizer",
                "{\"approved\":false}", admin);
        assertThat(denied.<List<String>>json("$.roles")).containsExactly("PARTICIPANT");
        assertThat(denied.<String>json("$.organizerRequest")).isEqualTo("DENIED");
        // a conferência no banco vale antes de o token expirar
        assertThat(http().get("/api/v1/users?name=Ca", newToken).status()).isEqualTo(403);
    }

    @Test
    void decisionValidatesBodyTargetAndNeverTouchesAdmins() {
        String tag = tag();
        String admin = adminToken(tag);
        String other = register("Outro " + tag, "outro-" + tag + "@example.com", null).json("$.id");
        String adminId = http().get("/api/v1/users/me", admin).json("$.id");

        assertThat(http().send("PUT", "/api/v1/admin/users/" + other + "/organizer", "{}", admin).status())
                .isEqualTo(400);
        assertThat(http().send("PUT", "/api/v1/admin/users/" + other + "/organizer", "{\"approved\":\"sim\"}", admin)
                .status()).isEqualTo(400);
        assertThat(http().send("PUT", "/api/v1/admin/users/" + UUID.randomUUID() + "/organizer",
                "{\"approved\":true}", admin).status()).isEqualTo(404);
        Http.Result self = http().send("PUT", "/api/v1/admin/users/" + adminId + "/organizer",
                "{\"approved\":true}", admin);
        assertThat(self.status()).isEqualTo(409);
        assertThat(self.body()).contains("ADMIN_TARGET_NOT_ALLOWED");
    }
}
