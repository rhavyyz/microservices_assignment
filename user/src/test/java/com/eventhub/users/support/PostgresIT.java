package com.eventhub.users.support;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Base dos testes de integração: aplicação completa (Tomcat em porta aleatória) sobre um PostgreSQL real
 * (Testcontainers; exige Docker) e uma chave JWT gerada na hora. Um único contêiner é compartilhado pela JVM.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public abstract class PostgresIT {

    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:16-alpine");
    static final Path KEY_FILE;

    static {
        POSTGRES.start();
        try {
            KEY_FILE = TestKeys.writePem(Files.createTempFile("users-it-", ".pem"), TestKeys.generate(2048));
            KEY_FILE.toFile().deleteOnExit();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", POSTGRES::getUsername);
        r.add("spring.datasource.password", POSTGRES::getPassword);
        r.add("users.jwt.private-key-file", KEY_FILE::toString);
        r.add("users.jwt.key-id", () -> "users-key-it");
        r.add("users.jwt.ttl-seconds", () -> "1800");
        r.add("users.password.bcrypt-strength", () -> "4");
        r.add("users.discovery.enabled", () -> "false");
    }

    @Value("${local.server.port}")
    int port;

    protected Http http() {
        return new Http(port);
    }
}
