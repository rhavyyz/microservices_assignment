package com.eventhub.users.dev;

import java.util.EnumSet;

import com.eventhub.users.audit.AuditLogger;
import com.eventhub.users.config.UsersProperties;
import com.eventhub.users.user.Role;
import com.eventhub.users.user.User;
import com.eventhub.users.user.UserRepository;
import com.eventhub.users.user.UserService;

import java.time.Clock;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * Organizador de demonstração para desenvolvimento local (ADR-002). DESATIVADO por padrão: só existe quando
 * {@code USERS_DEV_SEED_ENABLED=true}, e as credenciais vêm exclusivamente do ambiente. Não é exposto por HTTP.
 */
@Component
@ConditionalOnProperty(name = "users.dev-seed.enabled", havingValue = "true")
class DevSeed implements ApplicationRunner {

    private static final Logger LOG = LoggerFactory.getLogger(DevSeed.class);

    private final UsersProperties.DevSeed seed;
    private final UserRepository users;
    private final PasswordEncoder encoder;
    private final Clock clock;

    DevSeed(UsersProperties props, UserRepository users, PasswordEncoder encoder, Clock clock) {
        this.seed = props.devSeed();
        this.users = users;
        this.encoder = encoder;
        this.clock = clock;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (blank(seed.name()) || blank(seed.email()) || blank(seed.password())) {
            throw new IllegalStateException(
                    "USERS_DEV_SEED_ENABLED=true exige USERS_DEV_SEED_NAME, USERS_DEV_SEED_EMAIL e USERS_DEV_SEED_PASSWORD.");
        }
        String email = UserService.normalizeEmail(seed.email());
        if (users.existsByEmail(email)) {
            return;
        }
        users.save(User.create(seed.name().strip(), email, encoder.encode(seed.password()),
                EnumSet.of(Role.PARTICIPANT, Role.ORGANIZER), clock.instant()));
        LOG.warn("DEV SEED ativo: organizador de demonstração criado (emailFingerprint={}). Não use em produção.",
                AuditLogger.fingerprint(email));
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
