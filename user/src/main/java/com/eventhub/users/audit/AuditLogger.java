package com.eventhub.users.audit;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.spi.LoggingEventBuilder;
import org.springframework.stereotype.Component;

/**
 * Audit Logging: um evento estruturado (pares chave=valor) por operação relevante, no logger {@code AUDIT}.
 * Timestamp e {@code traceId} vêm do padrão de log/MDC. Nunca recebe senha, token ou chave; e-mails de
 * tentativas recusadas aparecem apenas como impressão digital (SHA-256 truncado).
 */
@Component
public class AuditLogger {

    public enum Operation { REGISTER, LOGIN, PROFILE_UPDATE, TOKEN_REJECTED, ACCESS_DENIED }

    public enum Result { SUCCESS, FAILURE }

    private static final Logger LOG = LoggerFactory.getLogger("AUDIT");

    public void record(Operation operation, Result result, UUID userId, String emailFingerprint) {
        LoggingEventBuilder b = (result == Result.SUCCESS ? LOG.atInfo() : LOG.atWarn())
                .addKeyValue("operation", operation.name())
                .addKeyValue("result", result.name());
        if (userId != null) {
            b = b.addKeyValue("userId", userId.toString());
        }
        if (emailFingerprint != null) {
            b = b.addKeyValue("emailFingerprint", emailFingerprint);
        }
        b.log("audit");
    }

    public static String fingerprint(String normalizedEmail) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(normalizedEmail.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(d, 0, 6);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
