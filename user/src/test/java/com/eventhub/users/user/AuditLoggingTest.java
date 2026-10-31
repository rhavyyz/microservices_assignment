package com.eventhub.users.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.util.EnumSet;
import java.util.Optional;
import java.util.stream.Collectors;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;

import com.eventhub.users.audit.AuditLogger;
import com.eventhub.users.web.ApiException;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.slf4j.LoggerFactory;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

/** Garante que a trilha de auditoria registra os eventos sem senha e sem e-mail em claro. */
@ExtendWith(MockitoExtension.class)
class AuditLoggingTest {

    private static final String PW = "senha-secreta-123";

    @Mock
    UserRepository repo;
    final ListAppender<ILoggingEvent> appender = new ListAppender<>();
    Logger root;

    @BeforeEach
    void attach() {
        root = (Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
        appender.start();
        root.addAppender(appender);
    }

    @AfterEach
    void detach() {
        root.detachAppender(appender);
    }

    private String logged() {
        return appender.list.stream()
                .map(e -> e.getFormattedMessage() + " " + e.getKeyValuePairs())
                .collect(Collectors.joining("\n"));
    }

    @Test
    void auditEventsAreRecordedWithoutSecretsOrRawEmail() {
        var encoder = new BCryptPasswordEncoder(4);
        var service = new UserService(repo, encoder, Clock.systemUTC(), new AuditLogger());
        when(repo.existsByEmail("pessoa@example.com")).thenReturn(false);
        when(repo.saveAndFlush(any(User.class))).thenAnswer(i -> i.getArgument(0));
        when(repo.findByEmail("pessoa@example.com")).thenReturn(Optional.of(
                User.create("Pessoa", "pessoa@example.com", encoder.encode(PW), EnumSet.of(Role.PARTICIPANT),
                        Clock.systemUTC().instant())));

        service.register("Pessoa", "pessoa@example.com", PW);
        service.authenticate("pessoa@example.com", PW);
        try {
            service.authenticate("pessoa@example.com", "errada-errada-123");
        } catch (ApiException expected) {
            // esperado
        }

        String out = logged();
        assertThat(out).contains("REGISTER", "LOGIN", "FAILURE",
                "emailFingerprint");
        assertThat(out).doesNotContain(PW).doesNotContain("errada-errada-123")
                .doesNotContain("pessoa@example.com").doesNotContain("$2a$");
    }
}
