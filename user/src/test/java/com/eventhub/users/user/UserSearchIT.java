package com.eventhub.users.user;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

import com.eventhub.users.support.Http;
import com.eventhub.users.support.PostgresIT;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/** Busca de usuários: autorização, filtros (id, e-mail, nome), paginação e ausência de dados sensíveis. */
class UserSearchIT extends PostgresIT {

    private static final String PW = "senha-forte-de-teste-123";

    @Autowired
    JdbcTemplate jdbc;

    private static String q(String v) {
        return URLEncoder.encode(v, StandardCharsets.UTF_8);
    }

    private String register(String name, String email) {
        Http.Result r = http().post("/api/v1/auth/register",
                "{\"name\":\"" + name + "\",\"email\":\"" + email + "\",\"password\":\"" + PW + "\"}");
        assertThat(r.status()).isEqualTo(201);
        return r.json("$.id");
    }

    private String login(String email) {
        return http().post("/api/v1/auth/login", "{\"email\":\"" + email + "\",\"password\":\"" + PW + "\"}")
                .json("$.accessToken");
    }

    private void promote(String id) {
        jdbc.update("insert into user_roles (user_id, role) values (?::uuid, 'ORGANIZER')", id);
    }

    private static long total(Http.Result r) {
        return ((Number) r.json("$.totalElements")).longValue();
    }

    private static int count(Http.Result r) {
        return r.<List<Object>>json("$.items").size();
    }

    /** Cria 3 usuários com um marcador único e um organizador. */
    private record Fixture(String tag, String ana, String bruno, String carla, String orgToken) {
    }

    private Fixture fixture() {
        String tag = UUID.randomUUID().toString().substring(0, 8);
        String ana = register("Ana Zeta-" + tag, "ana-" + tag + "@example.com");
        String bruno = register("Bruno Zeta-" + tag, "bruno-" + tag + "@example.com");
        String carla = register("Carla Outra-" + tag, "carla-" + tag + "@example.com");
        String orgId = register("Org " + tag, "org-" + tag + "@example.com");
        promote(orgId);
        return new Fixture(tag, ana, bruno, carla, login("org-" + tag + "@example.com"));
    }

    @Test
    void onlyOrganizersMaySearch() {
        Fixture f = fixture();
        String participantToken = login("ana-" + f.tag() + "@example.com");
        Http.Result forbidden = http().get("/api/v1/users?name=Zeta", participantToken);
        assertThat(forbidden.status()).isEqualTo(403);
        assertThat(forbidden.<String>json("$.code")).isEqualTo("ACCESS_DENIED");
        assertThat(http().get("/api/v1/users?name=Zeta", null).status()).isEqualTo(401);
        assertThat(http().get("/api/v1/users?name=Zeta", f.orgToken()).status()).isEqualTo(200);
    }

    @Test
    void demotedOrganizerLosesAccessBeforeTheTokenExpires() {
        Fixture f = fixture();
        assertThat(http().get("/api/v1/users?name=Zeta", f.orgToken()).status()).isEqualTo(200);
        jdbc.update("delete from user_roles where role = 'ORGANIZER' and user_id = (select id from users where email = ?)",
                "org-" + f.tag() + "@example.com");
        assertThat(http().get("/api/v1/users?name=Zeta", f.orgToken()).status()).isEqualTo(403);
    }

    @Test
    void filtersById() {
        Fixture f = fixture();
        Http.Result r = http().get("/api/v1/users?id=" + f.bruno(), f.orgToken());
        assertThat(r.status()).isEqualTo(200);
        assertThat(total(r)).isEqualTo(1);
        assertThat(r.<String>json("$.items[0].id")).isEqualTo(f.bruno());
        assertThat(r.<String>json("$.items[0].email")).isEqualTo("bruno-" + f.tag() + "@example.com");
        assertThat(r.<List<String>>json("$.items[0].roles")).containsExactly("PARTICIPANT");
        assertThat(r.<String>json("$.items[0].status")).isEqualTo("ACTIVE");
        assertThat(total(http().get("/api/v1/users?id=" + UUID.randomUUID(), f.orgToken()))).isZero();
    }

    @Test
    void filtersByEmailAndNameCaseInsensitiveAndCombinesWithAnd() {
        Fixture f = fixture();
        // nome: contém, sem diferenciar maiúsculas -> Ana e Bruno
        assertThat(total(http().get("/api/v1/users?name=" + q("ZETA-" + f.tag().toUpperCase()), f.orgToken()))).isEqualTo(2);
        // e-mail: contém -> só a Ana
        Http.Result byEmail = http().get("/api/v1/users?email=" + q("ANA-" + f.tag()), f.orgToken());
        assertThat(total(byEmail)).isEqualTo(1);
        assertThat(byEmail.<String>json("$.items[0].id")).isEqualTo(f.ana());
        // AND: nome Zeta + e-mail da Carla -> nada
        assertThat(total(http().get("/api/v1/users?name=" + q("zeta-" + f.tag()) + "&email=" + q("carla-" + f.tag()),
                f.orgToken()))).isZero();
        // AND: nome Zeta + e-mail do Bruno -> só o Bruno
        assertThat(total(http().get("/api/v1/users?name=" + q("zeta-" + f.tag()) + "&email=" + q("bruno-" + f.tag()),
                f.orgToken()))).isEqualTo(1);
    }

    @Test
    void wildcardCharactersAreLiteralNotPatterns() {
        Fixture f = fixture();
        assertThat(total(http().get("/api/v1/users?name=" + q("%%"), f.orgToken()))).isZero();
        assertThat(total(http().get("/api/v1/users?name=" + q("__"), f.orgToken()))).isZero();
        assertThat(total(http().get("/api/v1/users?email=" + q("%@%"), f.orgToken()))).isZero();
    }

    @Test
    void paginatesAndSortsByName() {
        Fixture f = fixture();
        String tagFilter = "?name=" + q("-" + f.tag()); // casa Ana, Bruno e Carla (o nome do organizador usa espaço, não hífen, antes do marcador)
        Http.Result page0 = http().get("/api/v1/users" + tagFilter + "&size=2&page=0", f.orgToken());
        Http.Result page1 = http().get("/api/v1/users" + tagFilter + "&size=2&page=1", f.orgToken());
        assertThat(total(page0)).isEqualTo(3);
        assertThat(page0.<Integer>json("$.totalPages")).isEqualTo(2);
        assertThat(count(page0)).isEqualTo(2);
        assertThat(count(page1)).isEqualTo(1);
        assertThat(page0.<String>json("$.items[0].name")).startsWith("Ana");
        assertThat(page0.<String>json("$.items[1].name")).startsWith("Bruno");
        assertThat(page1.<String>json("$.items[0].name")).startsWith("Carla");
    }

    @Test
    void rejectsInvalidInputWithoutEchoingValues() {
        Fixture f = fixture();
        String t = f.orgToken();
        for (String bad : new String[] { "", "?name=a", "?email=ab", "?name=maria&page=-1", "?name=maria&size=0",
                "?name=maria&size=51", "?name=maria&page=abc", "?id=nao-e-uuid" }) {
            Http.Result r = http().get("/api/v1/users" + bad, t);
            assertThat(r.status()).as(bad).isEqualTo(400);
            assertThat(r.<String>json("$.code")).as(bad).isEqualTo("VALIDATION_ERROR");
            assertThat(r.header("Content-Type")).startsWith("application/problem+json");
        }
        assertThat(http().get("/api/v1/users?id=nao-e-uuid", t).body()).doesNotContain("nao-e-uuid");
    }

    @Test
    void neverExposesPasswordMaterial() {
        Fixture f = fixture();
        String body = http().get("/api/v1/users?name=" + q("zeta-" + f.tag()), f.orgToken()).body().toLowerCase();
        assertThat(body).doesNotContain("password").doesNotContain("$2a$").doesNotContain("$2b$");
    }
}
