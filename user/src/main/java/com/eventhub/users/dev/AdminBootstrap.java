package com.eventhub.users.dev;

import java.time.Clock;
import java.time.temporal.ChronoUnit;
import java.util.EnumSet;

import com.eventhub.users.audit.AuditLogger;
import com.eventhub.users.config.UsersProperties;
import com.eventhub.users.user.Role;
import com.eventhub.users.user.User;
import com.eventhub.users.user.UserRepository;
import com.eventhub.users.user.UserService;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Cria o primeiro ADMIN (DT-11). DESATIVADO por padrão: só roda com {@code USERS_ADMIN_BOOTSTRAP_ENABLED=true} e
 * credenciais do ambiente; não há rota HTTP que conceda ADMIN. Idempotente: se o e-mail já existe, só garante o papel.
 */
@Component
@ConditionalOnProperty(name = "users.admin-bootstrap.enabled", havingValue = "true")
class AdminBootstrap implements ApplicationRunner {

    private static final Logger LOG = LoggerFactory.getLogger(AdminBootstrap.class);

    private final UsersProperties.AdminBootstrap config;
    private final UserRepository users;
    private final PasswordEncoder encoder;
    private final Clock clock;

    AdminBootstrap(UsersProperties props, UserRepository users, PasswordEncoder encoder, Clock clock) {
        this.config = props.adminBootstrap();
        this.users = users;
        this.encoder = encoder;
        this.clock = clock;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        if (blank(config.name()) || blank(config.email()) || blank(config.password())) {
            throw new IllegalStateException("USERS_ADMIN_BOOTSTRAP_ENABLED=true exige USERS_ADMIN_BOOTSTRAP_NAME, "
                    + "USERS_ADMIN_BOOTSTRAP_EMAIL e USERS_ADMIN_BOOTSTRAP_PASSWORD.");
        }
        var now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        String email = UserService.normalizeEmail(config.email());
        User existing = users.findByEmail(email).orElse(null);
        if (existing == null) {
            users.save(User.create(config.name().strip(), email, encoder.encode(config.password()),
                    EnumSet.of(Role.ADMIN), now));
        } else if (!existing.getRoles().contains(Role.ADMIN)) {
            existing.grantAdmin(now);
        } else {
            return;
        }
        LOG.warn("ADMIN bootstrap ativo: administrador garantido (emailFingerprint={}).",
                AuditLogger.fingerprint(email));
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
