package com.eventhub.users.openapi;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/** O contrato versionado (docs/api/users.openapi.yaml) declara o {@code x-gateway} de cada operação. */
public class GatewayExtensionTest {

    /** "METHOD path" -> {isPublic, requireAuth}; a mesma tabela é conferida contra o OpenAPI servido (InfraEndpointsIT). */
    public static final Map<String, boolean[]> EXPECTED = new LinkedHashMap<>();

    /** "METHOD path" -> {maxPerMin, rateLimitBy}: os limites que o Gateway deve semear (E1: login e cadastro, 10/min por IP). */
    public static final Map<String, Object[]> LIMITS = new LinkedHashMap<>();

    static {
        LIMITS.put("post /api/v1/auth/register", new Object[] {10, "ip"});
        LIMITS.put("post /api/v1/auth/login", new Object[] {10, "ip"});
        LIMITS.put("get /api/v1/users/me", new Object[] {120, "user_or_ip"});
        LIMITS.put("patch /api/v1/users/me", new Object[] {30, "user_or_ip"});
        LIMITS.put("get /api/v1/users", new Object[] {60, "user_or_ip"});
        LIMITS.put("get /api/v1/admin/users", new Object[] {60, "user_or_ip"});
        LIMITS.put("put /api/v1/admin/users/{id}/organizer", new Object[] {30, "user_or_ip"});

        EXPECTED.put("post /api/v1/auth/register", new boolean[] {true, false});
        EXPECTED.put("post /api/v1/auth/login", new boolean[] {true, false});
        EXPECTED.put("get /api/v1/users/me", new boolean[] {true, true});
        EXPECTED.put("patch /api/v1/users/me", new boolean[] {true, true});
        EXPECTED.put("get /api/v1/users", new boolean[] {true, true});
        EXPECTED.put("get /api/v1/admin/users", new boolean[] {true, true});
        EXPECTED.put("put /api/v1/admin/users/{id}/organizer", new boolean[] {true, true});
        EXPECTED.put("get /.well-known/jwks.json", new boolean[] {false, false});
        EXPECTED.put("get /internal/users/{id}", new boolean[] {false, false});
        EXPECTED.put("get /healthcheck", new boolean[] {false, false});
    }

    @Test
    @SuppressWarnings("unchecked")
    void everyOperationInTheCheckedInSpecDeclaresItsGatewaySettings() throws IOException {
        Path file = Path.of("..", "docs", "api", "users.openapi.yaml");
        if (!Files.exists(file)) {
            file = Path.of("docs", "api", "users.openapi.yaml");
        }
        Map<String, Object> spec = new Yaml().load(Files.readString(file));
        Map<String, Object> paths = (Map<String, Object>) spec.get("paths");

        Map<String, boolean[]> found = new LinkedHashMap<>();
        for (var path : paths.entrySet()) {
            for (var op : ((Map<String, Object>) path.getValue()).entrySet()) {
                if (!Map.of("get", 1, "put", 1, "post", 1, "delete", 1, "patch", 1, "head", 1, "options", 1)
                        .containsKey(op.getKey())) {
                    continue;
                }
                Object ext = ((Map<String, Object>) op.getValue()).get("x-gateway");
                String id = op.getKey() + " " + path.getKey();
                assertThat(ext).as("x-gateway of %s", id).isInstanceOf(Map.class);
                Map<String, Object> g = (Map<String, Object>) ext;
                assertThat(g.get("isPublic")).as("isPublic of %s", id).isInstanceOf(Boolean.class);
                assertThat(g.get("requireAuth")).as("requireAuth of %s", id).isInstanceOf(Boolean.class);
                Object[] limit = LIMITS.get(id);
                if (limit != null) {
                    assertThat(g.get("maxPerMin")).as("maxPerMin of %s", id).isEqualTo(limit[0]);
                    assertThat(g.get("rateLimitBy")).as("rateLimitBy of %s", id).isEqualTo(limit[1]);
                }
                found.put(id, new boolean[] {(Boolean) g.get("isPublic"), (Boolean) g.get("requireAuth")});
            }
        }
        assertThat(found.keySet()).containsExactlyInAnyOrderElementsOf(EXPECTED.keySet());
        EXPECTED.forEach((id, want) -> assertThat(found.get(id)).as(id).containsExactly(want[0], want[1]));
    }
}
