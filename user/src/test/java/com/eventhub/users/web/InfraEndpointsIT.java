package com.eventhub.users.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;

import com.eventhub.users.openapi.GatewayExtensionTest;
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
        assertThat(r.<Object>json("$.paths['/api/v1/admin/users'].get")).isNotNull();
        assertThat(r.<Object>json("$.paths['/api/v1/admin/users/{id}/organizer'].put")).isNotNull();
    }

    @Test
    @SuppressWarnings("unchecked")
    void everyServedOperationDeclaresItsGatewaySettings() {
        var r = http().get("/openapi.json", null);
        Map<String, Map<String, Object>> paths = r.json("$.paths");
        int seen = 0;
        for (var path : paths.entrySet()) {
            for (var op : path.getValue().entrySet()) {
                String id = op.getKey() + " " + path.getKey();
                var want = GatewayExtensionTest.EXPECTED.get(id);
                assertThat(want).as("unexpected operation %s", id).isNotNull();
                var ext = (Map<String, Object>) ((Map<String, Object>) op.getValue()).get("x-gateway");
                assertThat(ext).as("x-gateway of %s", id).isNotNull();
                assertThat(ext.get("isPublic")).as("isPublic of %s", id).isEqualTo(want[0]);
                assertThat(ext.get("requireAuth")).as("requireAuth of %s", id).isEqualTo(want[1]);
                var limit = GatewayExtensionTest.LIMITS.get(id);
                if (limit != null) {
                    assertThat(ext.get("maxPerMin")).as("maxPerMin of %s", id).isEqualTo(limit[0]);
                    assertThat(ext.get("rateLimitBy")).as("rateLimitBy of %s", id).isEqualTo(limit[1]);
                }
                seen++;
            }
        }
        assertThat(seen).isPositive();
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
