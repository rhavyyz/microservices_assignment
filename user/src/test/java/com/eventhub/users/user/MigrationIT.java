package com.eventhub.users.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.EnumSet;
import java.util.UUID;

import com.eventhub.users.support.PostgresIT;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

/** Esquema criado pelo Flyway, mapeamento JPA (ddl-auto=validate) e constraints no PostgreSQL real. */
class MigrationIT extends PostgresIT {

    @Autowired
    JdbcTemplate jdbc;
    @Autowired
    UserRepository repo;

    private static String email() {
        return "mig-" + UUID.randomUUID().toString().substring(0, 8) + "@example.com";
    }

    private void insertUser(String email, String status) {
        jdbc.update("insert into users(id,name,email,password_hash,status,created_at,updated_at) values (?,?,?,?,?,now(),now())",
                UUID.randomUUID(), "Nome", email, "$2a$04$hash", status);
    }

    @Test
    void flywayAppliedV1() {
        assertThat(jdbc.queryForObject(
                "select count(*) from flyway_schema_history where version = '1' and success", Integer.class)).isEqualTo(1);
    }

    @Test
    void databaseRejectsDuplicateEmail() {
        String e = email();
        insertUser(e, "ACTIVE");
        assertThatThrownBy(() -> insertUser(e, "ACTIVE")).isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("uk_users_email");
    }

    @Test
    void databaseRejectsNonNormalizedEmailAndInvalidStatus() {
        assertThatThrownBy(() -> insertUser("Maiuscula@Example.com", "ACTIVE"))
                .hasMessageContaining("ck_users_email_normalized");
        assertThatThrownBy(() -> insertUser(" " + email(), "ACTIVE")).hasMessageContaining("ck_users_email_normalized");
        assertThatThrownBy(() -> insertUser(email(), "ADMIN")).hasMessageContaining("ck_users_status");
    }

    @Test
    void databaseRejectsInvalidRoleAndOrphanRole() {
        String e = email();
        insertUser(e, "ACTIVE");
        UUID id = jdbc.queryForObject("select id from users where email = ?", UUID.class, e);
        assertThatThrownBy(() -> jdbc.update("insert into user_roles values (?, 'ADMIN')", id))
                .hasMessageContaining("ck_user_roles_role");
        assertThatThrownBy(() -> jdbc.update("insert into user_roles values (?, 'PARTICIPANT')", UUID.randomUUID()))
                .hasMessageContaining("fk_user_roles_user");
    }

    @Test
    void jpaMappingPersistsAndLoadsRolesAndRejectsDuplicateEmail() {
        String e = email();
        User saved = repo.saveAndFlush(User.create("Nome", e, "$2a$04$hash", EnumSet.of(Role.PARTICIPANT), Instant.now()));
        assertThat(repo.findByEmail(e)).get().satisfies(u -> {
            assertThat(u.getId()).isEqualTo(saved.getId());
            assertThat(u.getRoles()).containsExactly(Role.PARTICIPANT);
        });
        assertThatThrownBy(() -> repo.saveAndFlush(
                User.create("Outro", e, "$2a$04$hash", EnumSet.of(Role.PARTICIPANT), Instant.now())))
                .isInstanceOf(DataIntegrityViolationException.class);
    }
}
