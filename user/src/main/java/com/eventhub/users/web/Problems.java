package com.eventhub.users.web;

import java.io.IOException;
import java.util.List;

import jakarta.servlet.http.HttpServletResponse;

import org.slf4j.MDC;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/**
 * Corpo de erro {@code application/problem+json} (RFC 9457) com {@code code} estável e {@code traceId}.
 * O JSON é montado à mão para que o mesmo formato sirva ao handler MVC e à cadeia de segurança
 * (que responde antes do MVC), sem depender de configuração do serializador. Nunca inclui stack trace,
 * SQL, valores rejeitados ou qualquer detalhe interno.
 */
public final class Problems {

    public record FieldIssue(String field, String message) {
    }

    private Problems() {
    }

    public static String currentTraceId() {
        String id = MDC.get(CorrelationIdFilter.MDC_KEY);
        return id == null ? "unavailable" : id;
    }

    public static String json(int status, String title, String detail, String code, List<FieldIssue> errors) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"type\":\"about:blank\",\"title\":").append(quote(title))
                .append(",\"status\":").append(status)
                .append(",\"detail\":").append(quote(detail))
                .append(",\"code\":").append(quote(code))
                .append(",\"traceId\":").append(quote(currentTraceId()));
        if (errors != null && !errors.isEmpty()) {
            sb.append(",\"errors\":[");
            for (int i = 0; i < errors.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append("{\"field\":").append(quote(errors.get(i).field()))
                        .append(",\"message\":").append(quote(errors.get(i).message())).append('}');
            }
            sb.append(']');
        }
        return sb.append('}').toString();
    }

    public static ResponseEntity<String> response(int status, String title, String detail, String code,
            List<FieldIssue> errors) {
        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(json(status, title, detail, code, errors));
    }

    /** Escreve o erro diretamente na resposta (usado por filtros/handlers de segurança). */
    public static void write(HttpServletResponse res, int status, String title, String detail, String code)
            throws IOException {
        res.setStatus(status);
        res.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        res.setCharacterEncoding("UTF-8");
        res.getWriter().write(json(status, title, detail, code, null));
    }

    static String quote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.append('"').toString();
    }
}
