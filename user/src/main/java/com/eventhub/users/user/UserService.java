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
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
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
    static final int MAX_PAGE_SIZE = 50;
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

    /**
     * Busca de usuários para organizadores. Exige ao menos um filtro (não há listagem irrestrita), pagina sempre
     * (máx. {@value #MAX_PAGE_SIZE} por página) e confere o papel do solicitante no banco, não só no token.
     * Os valores filtrados nunca vão para o log de auditoria (são dados pessoais).
     */
    @Transactional(readOnly = true)
    public Page<User> search(UUID requesterId, UUID id, String email, String name, int page, int size) {
        User requester = getActive(requesterId);
        if (!requester.getRoles().contains(Role.ORGANIZER)) {
            audit.record(Operation.ACCESS_DENIED, Result.FAILURE, requesterId, null);
            throw ApiException.forbidden();
        }
        String emailTerm = blankToNull(email);
        String nameTerm = blankToNull(name);
        if (id == null && emailTerm == null && nameTerm == null) {
            throw ApiException.validation("filters", "Informe ao menos um filtro: id, email ou name.");
        }
        if (emailTerm != null && (emailTerm.length() < 3 || emailTerm.length() > 254)) {
            throw ApiException.validation("email", "O filtro de e-mail deve ter entre 3 e 254 caracteres.");
        }
        if (nameTerm != null && (nameTerm.length() < 2 || nameTerm.length() > 120)) {
            throw ApiException.validation("name", "O filtro de nome deve ter entre 2 e 120 caracteres.");
        }
        if (page < 0) {
            throw ApiException.validation("page", "A página deve ser maior ou igual a 0.");
        }
        if (size < 1 || size > MAX_PAGE_SIZE) {
            throw ApiException.validation("size", "O tamanho da página deve estar entre 1 e " + MAX_PAGE_SIZE + ".");
        }
        Page<User> result = users.findAll(UserSpecifications.matching(id, emailTerm, nameTerm),
                PageRequest.of(page, size, Sort.by("name").ascending().and(Sort.by("id").ascending())));
        audit.record(Operation.USER_SEARCH, Result.SUCCESS, requesterId, null);
        return result;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
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
