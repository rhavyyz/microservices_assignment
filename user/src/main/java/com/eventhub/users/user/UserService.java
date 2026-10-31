package com.eventhub.users.user;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.EnumSet;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

import com.eventhub.users.audit.AuditLogger;
import com.eventhub.users.audit.AuditLogger.Operation;
import com.eventhub.users.audit.AuditLogger.Result;
import com.eventhub.users.web.ApiException;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Regras de cadastro, autenticação e perfil.
 *
 * <p>Política de e-mail: {@code strip()} + minúsculas ({@code Locale.ROOT}) antes de qualquer busca ou gravação;
 * o banco recusa formas não normalizadas (constraint {@code ck_users_email_normalized}).
 */
@Service
public class UserService {

    /** O BCrypt considera apenas os primeiros 72 bytes: senhas maiores são recusadas em vez de truncadas. */
    static final int BCRYPT_MAX_BYTES = 72;
    private static final Pattern CONTROL_CHARS = Pattern.compile("\\p{Cntrl}");

    private final UserRepository users;
    private final PasswordEncoder encoder;
    private final Clock clock;
    private final AuditLogger audit;
    /** Hash descartável para igualar o tempo de resposta do login quando o e-mail não existe. */
    private final String dummyHash;

    public UserService(UserRepository users, PasswordEncoder encoder, Clock clock, AuditLogger audit) {
        this.users = users;
        this.encoder = encoder;
        this.clock = clock;
        this.audit = audit;
        this.dummyHash = encoder.encode(UUID.randomUUID().toString());
    }

    public static String normalizeEmail(String raw) {
        return raw.strip().toLowerCase(Locale.ROOT);
    }

    /** Cadastro público: sempre {@code PARTICIPANT}; nenhum parâmetro de papel existe nesta assinatura. */
    public User register(String rawName, String rawEmail, String password) {
        String name = normalizeName(rawName);
        String email = normalizeEmail(rawEmail);
        requirePasswordWithinHashLimit(password);

        if (users.existsByEmail(email)) {
            audit.record(Operation.REGISTER, Result.FAILURE, null, AuditLogger.fingerprint(email));
            throw ApiException.emailAlreadyRegistered();
        }
        User user = User.create(name, email, encoder.encode(password), EnumSet.of(Role.PARTICIPANT), clock.instant());
        try {
            user = users.saveAndFlush(user);
        } catch (DataIntegrityViolationException e) {
            // Cadastros concorrentes: a constraint única do banco é a barreira final.
            if (users.existsByEmail(email)) {
                audit.record(Operation.REGISTER, Result.FAILURE, null, AuditLogger.fingerprint(email));
                throw ApiException.emailAlreadyRegistered();
            }
            throw e;
        }
        audit.record(Operation.REGISTER, Result.SUCCESS, user.getId(), null);
        return user;
    }

    /** Valida credenciais. Toda falha produz a mesma exceção (sem indicar se o e-mail existe). */
    public User authenticate(String rawEmail, String password) {
        String email = normalizeEmail(rawEmail);
        User user = users.findByEmail(email).orElse(null);
        String hash = user != null ? user.getPasswordHash() : dummyHash;
        boolean passwordOk = withinHashLimit(password) && encoder.matches(password, hash);

        if (user == null || !passwordOk || user.getStatus() != UserStatus.ACTIVE) {
            audit.record(Operation.LOGIN, Result.FAILURE, user != null ? user.getId() : null,
                    AuditLogger.fingerprint(email));
            throw ApiException.invalidCredentials();
        }
        audit.record(Operation.LOGIN, Result.SUCCESS, user.getId(), null);
        return user;
    }

    @Transactional(readOnly = true)
    public User getActive(UUID id) {
        User user = users.findById(id).orElseThrow(ApiException::userNotFound);
        if (user.getStatus() != UserStatus.ACTIVE) {
            throw ApiException.accountInactive();
        }
        return user;
    }

    /** Atualiza somente o nome. O id vem do token validado, nunca do corpo da requisição. */
    @Transactional
    public User updateName(UUID id, String rawName) {
        User user = getActive(id);
        user.rename(normalizeName(rawName), clock.instant());
        audit.record(Operation.PROFILE_UPDATE, Result.SUCCESS, user.getId(), null);
        return user;
    }

    private static String normalizeName(String raw) {
        String name = raw == null ? "" : raw.strip();
        if (name.length() < 2 || name.length() > 120 || CONTROL_CHARS.matcher(name).find()) {
            throw ApiException.validation("name",
                    "Informe um nome entre 2 e 120 caracteres, sem caracteres de controle.");
        }
        return name;
    }

    private static boolean withinHashLimit(String password) {
        return password.getBytes(StandardCharsets.UTF_8).length <= BCRYPT_MAX_BYTES;
    }

    private static void requirePasswordWithinHashLimit(String password) {
        if (!withinHashLimit(password)) {
            throw ApiException.validation("password", "A senha deve ter no máximo 72 bytes (UTF-8).");
        }
    }
}
