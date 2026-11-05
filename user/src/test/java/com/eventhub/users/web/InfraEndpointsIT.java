package com.eventhub.users.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;

import com.eventhub.users.support.PostgresIT;

import org.junit.jupiter.api.Test;

/** Health check, OpenAPI lido pelo Gateway e JWKS (somente material público). */
class InfraEndpointsIT extends PostgresIT {

    @Test
    void healthcheckIsUpWithoutDetailsAndActuatorPathIsNotExposed() {
        var r = http().get("/healthcheck", null);
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.<String>json("$.status")).isEqualTo("UP");
        assertThat(r.body()).doesNotContain("components").doesNotContain("details").doesNotContain("jdbc");
        assertThat(http().get("/actuator/health", null).status()).isNotEqualTo(200);
        assertThat(http().get("/env", null).status()).isNotEqualTo(200);
    }

    @Test
    void openApiJsonListsEveryRouteTheGatewayShouldKnow() {
        var r = http().get("/openapi.json", null);
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.<Object>json("$.paths['/api/v1/auth/register'].post")).isNotNull();
        assertThat(r.<Object>json("$.paths['/api/v1/auth/login'].post")).isNotNull();
        assertThat(r.<Object>json("$.paths['/api/v1/users/me'].get")).isNotNull();
        assertThat(r.<Object>json("$.paths['/api/v1/users/me'].patch")).isNotNull();
        assertThat(r.<Object>json("$.paths['/api/v1/users'].get")).isNotNull();
        assertThat(r.<Object>json("$.paths['/internal/users/{id}'].get")).isNotNull();
    }

    @Test
    void jwksPublishesOnlyThePublicKey() {
        var r = http().get("/.well-known/jwks.json", null);
        assertThat(r.status()).isEqualTo(200);
        Map<String, Object> key = r.json("$.keys[0]");
        assertThat(key).containsEntry("kty", "RSA").containsEntry("kid", "users-key-it")
                .containsEntry("alg", "RS256").containsEntry("use", "sig").containsKeys("n", "e")
                .doesNotContainKeys("d", "p", "q", "dp", "dq", "qi");
    }
}
