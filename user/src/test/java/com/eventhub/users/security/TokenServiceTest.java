package com.eventhub.users.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.EnumSet;
import java.util.Set;

import com.eventhub.users.config.UsersProperties;
import com.eventhub.users.support.TestKeys;
import com.eventhub.users.user.Role;
import com.eventhub.users.user.User;
import com.nimbusds.jose.jwk.RSAKey;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.test.util.ReflectionTestUtils;

class TokenServiceTest {

    @TempDir
    Path dir;

    UsersProperties props;
    JwtConfig config = new JwtConfig();
    RSAKey key;
    JwtDecoder decoder;
    User user;

    @BeforeEach
    void setUp() throws Exception {
        Path pem = TestKeys.writePem(dir.resolve("k.pem"), TestKeys.generate(2048));
        props = TestKeys.props("eventhub-users", 1800, pem);
        key = config.signingKey(props);
        decoder = config.jwtDecoder(key, props);
        user = User.create("Mariana", "mariana@example.com", "$2a$04$hash", EnumSet.of(Role.PARTICIPANT),
                Instant.now());
        ReflectionTestUtils.setField(user, "id", java.util.UUID.randomUUID());
    }

    private TokenService serviceAt(Instant now) {
        return new TokenService(config.jwtEncoder(key), props, Clock.fixed(now, ZoneOffset.UTC));
    }

    @Test
    void issuesDocumentedClaimsOnly() {
        Instant now = Instant.now();
        TokenService.IssuedToken t = serviceAt(now).issue(user);
        Jwt jwt = decoder.decode(t.value());

        assertThat(t.expiresInSeconds()).isEqualTo(1800);
        assertThat(jwt.getSubject()).isEqualTo(user.getId().toString());
        assertThat(jwt.getClaimAsString("iss")).isEqualTo("eventhub-users");
        assertThat(jwt.<java.util.List<String>>getClaim("roles")).containsExactly("PARTICIPANT");
        assertThat(jwt.getId()).isNotBlank();
        assertThat(jwt.getExpiresAt().getEpochSecond() - jwt.getIssuedAt().getEpochSecond()).isEqualTo(1800);
        // Nada de e-mail, nome ou hash no token.
        assertThat(jwt.getClaims().keySet()).containsExactlyInAnyOrder("sub", "roles", "iss", "iat", "exp", "jti");
        assertThat(jwt.getHeaders()).containsEntry("alg", "RS256").containsEntry("kid", "kid-test");
    }

    @Test
    void rejectsExpiredToken() {
        String token = serviceAt(Instant.now().minusSeconds(3 * 3600)).issue(user).value();
        assertThatThrownBy(() -> decoder.decode(token)).isInstanceOf(JwtException.class);
    }

    @Test
    void rejectsTokenFromUntrustedIssuer() throws Exception {
        UsersProperties other = TestKeys.props("outro-emissor", 1800, dir.resolve("k.pem"));
        String token = new TokenService(config.jwtEncoder(key), other, Clock.systemUTC()).issue(user).value();
        assertThatThrownBy(() -> decoder.decode(token)).isInstanceOf(JwtException.class);
    }

    @Test
    void rejectsTokenSignedByAnotherKey() throws Exception {
        Path otherPem = TestKeys.writePem(dir.resolve("other.pem"), TestKeys.generate(2048));
        UsersProperties otherProps = TestKeys.props("eventhub-users", 1800, otherPem);
        RSAKey otherKey = config.signingKey(otherProps);
        String token = new TokenService(config.jwtEncoder(otherKey), otherProps, Clock.systemUTC()).issue(user).value();
        assertThatThrownBy(() -> decoder.decode(token)).isInstanceOf(JwtException.class);
    }

    @Test
    void rejectsTamperedPayloadAndAlgNone() {
        String token = serviceAt(Instant.now()).issue(user).value();
        String[] p = token.split("\\.");
        String forgedPayload = Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"sub\":\"00000000-0000-0000-0000-000000000000\",\"roles\":[\"ORGANIZER\"],\"iss\":\"eventhub-users\",\"exp\":9999999999}"
                        .getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> decoder.decode(p[0] + "." + forgedPayload + "." + p[2]))
                .isInstanceOf(JwtException.class);

        String noneHeader = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> decoder.decode(noneHeader + "." + forgedPayload + "."))
                .isInstanceOf(JwtException.class);
    }

    @Test
    void jwksContainsOnlyPublicMaterial() {
        String json = new JwksControllerAccess(key).json();
        assertThat(json).contains("\"kty\":\"RSA\"").contains("kid-test");
        for (String priv : Set.of("\"d\"", "\"p\"", "\"q\"", "\"dp\"", "\"dq\"", "\"qi\"")) {
            assertThat(json).doesNotContain(priv);
        }
    }

    /** Mesma lógica do controller, sem subir o contexto Spring. */
    private record JwksControllerAccess(RSAKey key) {
        String json() {
            return new com.eventhub.users.web.JwksController(key).jwks();
        }
    }
}
