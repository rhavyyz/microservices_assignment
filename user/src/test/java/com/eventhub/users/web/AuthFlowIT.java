package com.eventhub.users.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;

import com.eventhub.users.support.Http;
import com.eventhub.users.support.PostgresIT;
import com.eventhub.users.support.TestKeys;

import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;

class AuthFlowIT extends PostgresIT {

    static final String PW = "senha-forte-de-teste-123";

    @Autowired
    JdbcTemplate jdbc;
    @Autowired
    JwtEncoder encoder;

    // ---------- helpers ----------

    static String uniqueEmail() {
        return "user-" + UUID.randomUUID().toString().substring(0, 8) + "@example.com";
    }

    static String registerBody(String email) {
        return "{\"name\":\"Mariana Costa\",\"email\":\"" + email + "\",\"password\":\"" + PW + "\"}";
    }

    Http.Result register(String email) {
        return http().post("/api/v1/auth/register", registerBody(email));
    }

    String loginToken(String email) {
        Http.Result r = http().post("/api/v1/auth/login", "{\"email\":\"" + email + "\",\"password\":\"" + PW + "\"}");
        assertThat(r.status()).isEqualTo(200);
        return r.json("$.accessToken");
    }

    String token(String sub, List<String> roles, String issuer, Instant iat, Instant exp, JwtEncoder enc) {
        JwtClaimsSet claims = JwtClaimsSet.builder().issuer(issuer).subject(sub).issuedAt(iat).expiresAt(exp)
                .id(UUID.randomUUID().toString()).claim("roles", roles).build();
        JwsHeader h = JwsHeader.with(SignatureAlgorithm.RS256).keyId("users-key-it").build();
        return enc.encode(JwtEncoderParameters.from(h, claims)).getTokenValue();
    }

    void assertProblem(Http.Result r, int status, String code) {
        assertThat(r.status()).isEqualTo(status);
        assertThat(r.header("Content-Type")).startsWith("application/problem+json");
        assertThat(r.<String>json("$.code")).isEqualTo(code);
        assertThat(r.<String>json("$.traceId")).isEqualTo(r.header("X-Request-Id"));
    }

    // ---------- cadastro ----------

    @Test
    void registerCreatesParticipantNormalizesEmailAndNeverExposesHash() {
        String email = uniqueEmail();
        Http.Result r = http().post("/api/v1/auth/register",
                "{\"name\":\"  Mariana Costa \",\"email\":\"  " + email.toUpperCase() + " \",\"password\":\"" + PW + "\"}");

        assertThat(r.status()).isEqualTo(201);
        assertThat(r.<List<String>>json("$.roles")).containsExactly("PARTICIPANT");
        assertThat(r.<String>json("$.email")).isEqualTo(email);
        assertThat(r.<String>json("$.name")).isEqualTo("Mariana Costa");
        assertThat(r.body().toLowerCase()).doesNotContain("password").doesNotContain("$2a$").doesNotContain("$2b$");

        String stored = jdbc.queryForObject("select password_hash from users where email = ?", String.class, email);
        assertThat(stored).startsWith("$2").isNotEqualTo(PW);
    }

    @Test
    void registerRejectsPrivilegedFieldsAndCreatesNothing() {
        String email = uniqueEmail();
        for (String extra : new String[] { "\"roles\":[\"ORGANIZER\"]", "\"isAdmin\":true", "\"isOrganizer\":true" }) {
            Http.Result r = http().post("/api/v1/auth/register",
                    "{\"name\":\"Maria\",\"email\":\"" + email + "\",\"password\":\"" + PW + "\"," + extra + "}");
            assertProblem(r, 400, "MALFORMED_REQUEST");
        }
        assertThat(jdbc.queryForObject("select count(*) from users where email = ?", Integer.class, email)).isZero();
    }

    @Test
    void registerDuplicateEmailIsConflictRegardlessOfCaseAndSpaces() {
        String email = uniqueEmail();
        assertThat(register(email).status()).isEqualTo(201);
        Http.Result dup = http().post("/api/v1/auth/register",
                "{\"name\":\"Outra\",\"email\":\" " + email.toUpperCase() + "\",\"password\":\"" + PW + "\"}");
        assertProblem(dup, 409, "EMAIL_ALREADY_REGISTERED");
    }

    @Test
    void registerValidationErrorsNameTheFieldAndNeverEchoSecrets() {
        Http.Result r = http().post("/api/v1/auth/register",
                "{\"name\":\"Maria\",\"email\":\"nao-e-email\",\"password\":\"curta\"}");
        assertProblem(r, 400, "VALIDATION_ERROR");
        List<String> fields = r.json("$.errors[*].field");
        assertThat(fields).contains("email", "password");
        assertThat(r.body()).doesNotContain("curta");
    }

    @Test
    void concurrentRegistrationsOfSameEmailYieldExactlyOneAccount() throws Exception {
        String email = uniqueEmail();
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Callable<Integer>> calls = new ArrayList<>();
            for (int i = 0; i < 8; i++) {
                calls.add(() -> register(email).status());
            }
            List<Integer> statuses = new ArrayList<>();
            for (Future<Integer> f : pool.invokeAll(calls)) {
                statuses.add(f.get());
            }
            assertThat(statuses).containsOnly(201, 409).filteredOn(s -> s == 201).hasSize(1);
        } finally {
            pool.shutdownNow();
        }
        assertThat(jdbc.queryForObject("select count(*) from users where email = ?", Integer.class, email)).isEqualTo(1);
    }

    // ---------- login ----------

    @Test
    void loginIssuesTokenWithDocumentedClaims() {
        String email = uniqueEmail();
        String id = register(email).json("$.id");
        Http.Result r = http().post("/api/v1/auth/login", "{\"email\":\"" + email + "\",\"password\":\"" + PW + "\"}");

        assertThat(r.status()).isEqualTo(200);
        assertThat(r.<String>json("$.tokenType")).isEqualTo("Bearer");
        assertThat(r.<Integer>json("$.expiresIn")).isEqualTo(1800);
        assertThat(r.<String>json("$.user.id")).isEqualTo(id);
        assertThat(r.body()).doesNotContain("password_hash").doesNotContain("passwordHash");

        String[] parts = r.<String>json("$.accessToken").split("\\.");
        String payload = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
        assertThat(payload).contains("\"sub\":\"" + id + "\"").contains("\"roles\":[\"PARTICIPANT\"]")
                .contains("\"iss\":\"eventhub-users\"").contains("\"jti\"").doesNotContain(email);
    }

    @Test
    void loginFailuresAreIdenticalForUnknownEmailAndWrongPassword() {
        String email = uniqueEmail();
        register(email);
        Http.Result wrong = http().post("/api/v1/auth/login",
                "{\"email\":\"" + email + "\",\"password\":\"senha-errada-123\"}");
        Http.Result unknown = http().post("/api/v1/auth/login",
                "{\"email\":\"" + uniqueEmail() + "\",\"password\":\"" + PW + "\"}");

        assertProblem(wrong, 401, "INVALID_CREDENTIALS");
        assertProblem(unknown, 401, "INVALID_CREDENTIALS");
        assertThat(unknown.<String>json("$.detail")).isEqualTo(wrong.<String>json("$.detail"));
        assertThat(unknown.<String>json("$.title")).isEqualTo(wrong.<String>json("$.title"));
    }

    // ---------- rotas protegidas ----------

    @Test
    void meRejectsMissingInvalidExpiredForgedAndUntrustedTokens() throws Exception {
        String email = uniqueEmail();
        String id = register(email).json("$.id");
        Instant now = Instant.now();
        // Token assinado por uma chave que o serviço não conhece, mas com o MESMO kid (ataque de kid forjado).
        // O kid precisa existir no JWK para o NimbusJwtEncoder selecioná-lo; o decoder deve rejeitar pela assinatura.
        java.security.KeyPair kp = TestKeys.generate(2048);
        JwtEncoder foreign = new NimbusJwtEncoder(new com.nimbusds.jose.jwk.source.ImmutableJWKSet<>(
                new com.nimbusds.jose.jwk.JWKSet(new com.nimbusds.jose.jwk.RSAKey.Builder(
                        (java.security.interfaces.RSAPublicKey) kp.getPublic()).privateKey(kp.getPrivate())
                        .keyID("users-key-it").build())));

        String noneHeader = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
        String nonePayload = Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"" + id + "\",\"iss\":\"eventhub-users\",\"exp\":9999999999}").getBytes(StandardCharsets.UTF_8));

        String[] bad = {
                null,
                "lixo.total.aqui",
                noneHeader + "." + nonePayload + ".",
                token(id, List.of("PARTICIPANT"), "eventhub-users", now.minusSeconds(7200), now.minusSeconds(3600), encoder),
                token(id, List.of("PARTICIPANT"), "emissor-nao-confiavel", now, now.plusSeconds(600), encoder),
                token(id, List.of("ORGANIZER"), "eventhub-users", now, now.plusSeconds(600), foreign),
        };
        for (String t : bad) {
            Http.Result r = http().get("/api/v1/users/me", t);
            assertProblem(r, 401, "UNAUTHENTICATED");
            assertThat(r.header("WWW-Authenticate")).startsWith("Bearer");
        }
    }

    @Test
    void meReturnsOnlyTheAuthenticatedUsersProfile() {
        String emailA = uniqueEmail();
        String emailB = uniqueEmail();
        String idA = register(emailA).json("$.id");
        String idB = register(emailB).json("$.id");
        String tokenA = loginToken(emailA);

        Http.Result me = http().get("/api/v1/users/me", tokenA);
        assertThat(me.status()).isEqualTo(200);
        assertThat(me.<String>json("$.id")).isEqualTo(idA).isNotEqualTo(idB);
        assertThat(me.<String>json("$.email")).isEqualTo(emailA);
        assertThat(me.body().toLowerCase()).doesNotContain("password").doesNotContain("$2a$");

        // Não existe rota para consultar terceiros pela API comum.
        assertProblem(http().get("/api/v1/users/" + idB, tokenA), 404, "NOT_FOUND");
        // A busca existe, mas é só para ORGANIZER: um participante recebe 403.
        assertProblem(http().get("/api/v1/users?name=Mariana", tokenA), 403, "ACCESS_DENIED");
    }

    @Test
    void patchUpdatesOnlyNameAndRejectsEverythingElse() {
        String email = uniqueEmail();
        register(email);
        String token = loginToken(email);

        Http.Result ok = http().send("PATCH", "/api/v1/users/me", "{\"name\":\"  Novo Nome \"}", token);
        assertThat(ok.status()).isEqualTo(200);
        assertThat(ok.<String>json("$.name")).isEqualTo("Novo Nome");
        assertThat(http().get("/api/v1/users/me", token).<String>json("$.name")).isEqualTo("Novo Nome");

        for (String extra : new String[] { "\"roles\":[\"ORGANIZER\"]", "\"email\":\"x@example.com\"",
                "\"password\":\"outra-senha-123\"", "\"id\":\"" + UUID.randomUUID() + "\"", "\"status\":\"INACTIVE\"" }) {
            Http.Result r = http().send("PATCH", "/api/v1/users/me", "{\"name\":\"Nome\"," + extra + "}", token);
            assertProblem(r, 400, "MALFORMED_REQUEST");
        }
        assertThat(http().get("/api/v1/users/me", token).<List<String>>json("$.roles")).containsExactly("PARTICIPANT");
        assertProblem(http().send("PATCH", "/api/v1/users/me", "{}", token), 400, "VALIDATION_ERROR");
        assertProblem(http().send("PATCH", "/api/v1/users/me", "{\"name\":\"x\"}", null), 401, "UNAUTHENTICATED");
    }

    // ---------- erros e rastreabilidade ----------

    @Test
    void correlationIdIsPropagatedWhenSafeAndReplacedWhenNot() {
        Http.Result kept = http().send("GET", "/api/v1/users/me", null, null, "X-Request-Id", "req-abc-12345");
        assertThat(kept.header("X-Request-Id")).isEqualTo("req-abc-12345");
        assertThat(kept.<String>json("$.traceId")).isEqualTo("req-abc-12345");

        Http.Result replaced = http().send("GET", "/api/v1/users/me", null, null, "X-Request-Id", "curto");
        assertThat(replaced.header("X-Request-Id")).isNotEqualTo("curto").matches("[0-9a-f-]{36}");
    }

    @Test
    void errorsAreStandardizedAndNeverLeakInternals() {
        String token = loginToken(registerAndGetEmail());
        Http.Result malformed = http().post("/api/v1/auth/login", "{nao-e-json");
        assertProblem(malformed, 400, "MALFORMED_REQUEST");
        assertProblem(http().send("GET", "/api/v1/auth/login", null, token), 405, "HTTP_405");
        Http.Result wrongType = http().send("POST", "/api/v1/auth/login", null, null, "Content-Type", "text/plain");
        assertThat(wrongType.status()).isIn(400, 415);

        for (Http.Result r : List.of(malformed, wrongType)) {
            assertThat(r.body()).doesNotContain("Exception").doesNotContain("org.springframework")
                    .doesNotContain("com.eventhub").doesNotContain("SELECT").doesNotContain("\tat ");
        }
    }

    String registerAndGetEmail() {
        String e = uniqueEmail();
        register(e);
        return e;
    }

    @Test
    void logsNeverContainPasswordsTokensOrAuthorizationHeaders() {
        Logger root = (Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        root.addAppender(appender);
        String secretPw = "senha-que-nao-pode-vazar-1";
        String email = uniqueEmail();
        String token;
        try {
            http().post("/api/v1/auth/register",
                    "{\"name\":\"Maria\",\"email\":\"" + email + "\",\"password\":\"" + secretPw + "\"}");
            Http.Result login = http().post("/api/v1/auth/login",
                    "{\"email\":\"" + email + "\",\"password\":\"" + secretPw + "\"}");
            token = login.json("$.accessToken");
            http().get("/api/v1/users/me", token);
            http().get("/api/v1/users/me", token + "adulterado");
            http().post("/api/v1/auth/login", "{\"email\":\"" + email + "\",\"password\":\"errada-errada-123\"}");
        } finally {
            root.detachAppender(appender);
        }
        StringBuilder all = new StringBuilder();
        for (ILoggingEvent e : new ArrayList<>(appender.list)) {
            all.append(e.getFormattedMessage()).append(' ').append(e.getKeyValuePairs()).append('\n');
        }
        assertThat(all.toString()).doesNotContain(secretPw).doesNotContain("errada-errada-123")
                .doesNotContain(token).doesNotContain("Bearer ").doesNotContain("Authorization");
    }
}
