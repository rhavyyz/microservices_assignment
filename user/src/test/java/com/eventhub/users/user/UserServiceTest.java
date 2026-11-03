package com.eventhub.users.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.EnumSet;
import java.util.UUID;
import java.util.Optional;

import com.eventhub.users.audit.AuditLogger;
import com.eventhub.users.web.ApiException;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.util.ReflectionTestUtils;

@ExtendWith(MockitoExtension.class)
class UserServiceTest {

    private static final String PW = "senha-forte-123";
    private static final Instant NOW = Instant.parse("2026-10-31T12:00:00Z");

    @Mock
    UserRepository repo;
    PasswordEncoder encoder = new BCryptPasswordEncoder(4);
    UserService service;

    @BeforeEach
    void setUp() {
        service = new UserService(repo, encoder, Clock.fixed(NOW, ZoneOffset.UTC), new AuditLogger());
    }

    private static void assertApi(Throwable t, String code) {
        assertThat(t).isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.code()).isEqualTo(code));
    }

    private User existing(String email) {
        return User.create("Maria", email, encoder.encode(PW), EnumSet.of(Role.PARTICIPANT), NOW);
    }

    @Test
    void registerNormalizesEmailHashesPasswordAndGrantsOnlyParticipant() {
        when(repo.existsByEmail("mariana@example.com")).thenReturn(false);
        when(repo.saveAndFlush(any(User.class))).thenAnswer(i -> i.getArgument(0));

        service.register("  Mariana Costa ", "  Mariana@Example.COM ", PW);

        ArgumentCaptor<User> saved = ArgumentCaptor.forClass(User.class);
        verify(repo).saveAndFlush(saved.capture());
        User u = saved.getValue();
        assertThat(u.getEmail()).isEqualTo("mariana@example.com");
        assertThat(u.getName()).isEqualTo("Mariana Costa");
        assertThat(u.getRoles()).containsExactly(Role.PARTICIPANT);
        assertThat(u.getStatus()).isEqualTo(UserStatus.ACTIVE);
        assertThat(u.getPasswordHash()).isNotEqualTo(PW).startsWith("$2");
        assertThat(encoder.matches(PW, u.getPasswordHash())).isTrue();
        assertThat(u.getCreatedAt()).isEqualTo(NOW);
    }

    @Test
    void registerRejectsDuplicateEmailWithoutSaving() {
        when(repo.existsByEmail("a@example.com")).thenReturn(true);
        assertThatThrownBy(() -> service.register("Maria", "A@example.com", PW))
                .satisfies(t -> assertApi(t, "EMAIL_ALREADY_REGISTERED"));
        verify(repo, never()).saveAndFlush(any());
    }

    @Test
    void concurrentDuplicateCaughtByDatabaseConstraintBecomesConflict() {
        when(repo.existsByEmail("a@example.com")).thenReturn(false, true);
        when(repo.saveAndFlush(any())).thenThrow(new DataIntegrityViolationException("uk_users_email"));
        assertThatThrownBy(() -> service.register("Maria", "a@example.com", PW))
                .satisfies(t -> assertApi(t, "EMAIL_ALREADY_REGISTERED"));
    }

    @Test
    void otherIntegrityViolationsAreNotDisguisedAsConflict() {
        when(repo.existsByEmail("a@example.com")).thenReturn(false, false);
        when(repo.saveAndFlush(any())).thenThrow(new DataIntegrityViolationException("outra"));
        assertThatThrownBy(() -> service.register("Maria", "a@example.com", PW))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void registerRejectsPasswordOver72BytesEvenIfFewChars() {
        String sixtyChars80Bytes = "é".repeat(40); // 40 caracteres, 80 bytes
        assertThatThrownBy(() -> service.register("Maria", "a@example.com", sixtyChars80Bytes))
                .satisfies(t -> assertApi(t, "VALIDATION_ERROR"));
        verify(repo, never()).saveAndFlush(any());
    }

    @Test
    void registerRejectsBadNames() {
        for (String bad : new String[] { " a ", "x".repeat(121), "Ma\nria" }) {
            assertThatThrownBy(() -> service.register(bad, "a@example.com", PW))
                    .as(bad).satisfies(t -> assertApi(t, "VALIDATION_ERROR"));
        }
    }

    @Test
    void authenticateSucceedsWithValidCredentialsAndNormalizedEmail() {
        User u = existing("maria@example.com");
        when(repo.findByEmail("maria@example.com")).thenReturn(Optional.of(u));
        assertThat(service.authenticate(" MARIA@example.com ", PW)).isSameAs(u);
    }

    @Test
    void allAuthenticationFailuresAreIndistinguishable() {
        User wrongPw = existing("maria@example.com");
        User inactive = existing("inativa@example.com");
        ReflectionTestUtils.setField(inactive, "status", UserStatus.INACTIVE);
        when(repo.findByEmail("maria@example.com")).thenReturn(Optional.of(wrongPw));
        when(repo.findByEmail("inativa@example.com")).thenReturn(Optional.of(inactive));
        when(repo.findByEmail("ninguem@example.com")).thenReturn(Optional.empty());

        ApiException a = catchApi(() -> service.authenticate("maria@example.com", "senha-errada-123"));
        ApiException b = catchApi(() -> service.authenticate("ninguem@example.com", PW));
        ApiException c = catchApi(() -> service.authenticate("inativa@example.com", PW));
        ApiException d = catchApi(() -> service.authenticate("maria@example.com", "é".repeat(40)));

        for (ApiException e : new ApiException[] { a, b, c, d }) {
            assertThat(e.code()).isEqualTo("INVALID_CREDENTIALS");
            assertThat(e.getMessage()).isEqualTo(a.getMessage());
            assertThat(e.status().value()).isEqualTo(401);
        }
    }

    // ---------- busca de usuários ----------

    private User requester(Role... roles) {
        User u = User.create("Solicitante", "solicitante@example.com", "$2a$04$x", EnumSet.copyOf(java.util.List.of(roles)), NOW);
        ReflectionTestUtils.setField(u, "id", UUID.randomUUID());
        when(repo.findById(u.getId())).thenReturn(Optional.of(u));
        return u;
    }

    @Test
    void searchIsForbiddenToParticipantsEvenWithValidFilters() {
        User participant = requester(Role.PARTICIPANT);
        assertThatThrownBy(() -> service.search(participant.getId(), null, null, "maria", 0, 20))
                .satisfies(t -> assertApi(t, "ACCESS_DENIED"));
        verify(repo, never()).findAll(any(org.springframework.data.jpa.domain.Specification.class),
                any(org.springframework.data.domain.Pageable.class));
    }

    @Test
    void searchValidatesFiltersAndPaging() {
        User org = requester(Role.ORGANIZER);
        UUID id = org.getId();
        assertThatThrownBy(() -> service.search(id, null, null, null, 0, 20))
                .satisfies(t -> assertApi(t, "VALIDATION_ERROR"));          // sem filtro
        assertThatThrownBy(() -> service.search(id, null, "  ", " ", 0, 20))
                .satisfies(t -> assertApi(t, "VALIDATION_ERROR"));          // filtros em branco
        assertThatThrownBy(() -> service.search(id, null, "ab", null, 0, 20))
                .satisfies(t -> assertApi(t, "VALIDATION_ERROR"));          // e-mail curto
        assertThatThrownBy(() -> service.search(id, null, null, "a", 0, 20))
                .satisfies(t -> assertApi(t, "VALIDATION_ERROR"));          // nome curto
        assertThatThrownBy(() -> service.search(id, null, null, "maria", -1, 20))
                .satisfies(t -> assertApi(t, "VALIDATION_ERROR"));          // página negativa
        assertThatThrownBy(() -> service.search(id, null, null, "maria", 0, 0))
                .satisfies(t -> assertApi(t, "VALIDATION_ERROR"));          // tamanho 0
        assertThatThrownBy(() -> service.search(id, null, null, "maria", 0, 51))
                .satisfies(t -> assertApi(t, "VALIDATION_ERROR"));          // acima do máximo
    }

    @Test
    void searchRejectsInactiveRequester() {
        User org = requester(Role.ORGANIZER);
        ReflectionTestUtils.setField(org, "status", UserStatus.INACTIVE);
        assertThatThrownBy(() -> service.search(org.getId(), null, null, "maria", 0, 20))
                .satisfies(t -> assertApi(t, "ACCESS_DENIED"));
    }

    private static ApiException catchApi(Runnable r) {
        try {
            r.run();
        } catch (ApiException e) {
            return e;
        }
        throw new AssertionError("ApiException esperada");
    }
}
