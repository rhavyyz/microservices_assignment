package com.eventhub.users.web;

import java.io.IOException;
import java.util.regex.Pattern;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Access log: uma linha por requisição, no formato comum da plataforma (Gateway e Notifications):
 * {@code <METHOD> <path> status=<N> duration=<d>ms user=<id|-> trace_id=<id>}.
 * Roda logo depois do {@link TraceIdFilter} (o trace id já está definido) e escreve em {@code finally}, depois da
 * resposta, para refletir o status final (inclusive 401/403 do Spring Security e 404/500). Não registra query string
 * (a busca recebe filtros pessoais), corpo, Authorization nem tokens; {@code path} é só o URI.
 * O {@code user} vem do atributo {@link #SUBJECT_ATTRIBUTE}, preenchido por {@link AccessLogSubjectFilter} dentro da
 * cadeia de segurança (o SecurityContext já foi limpo quando este filtro termina) e só vale se tiver forma de UUID.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class AccessLogFilter extends OncePerRequestFilter {

    public static final String LOGGER_NAME = "com.eventhub.users.access";
    public static final String SUBJECT_ATTRIBUTE = AccessLogFilter.class.getName() + ".SUBJECT";

    private static final Logger ACCESS = LoggerFactory.getLogger(LOGGER_NAME);
    private static final Pattern UUID_SHAPE =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return path != null && (path.equals("/healthcheck") || path.equals("/actuator/health")
                || path.startsWith("/actuator/health/"));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long start = System.nanoTime();
        int failureStatus = 0;
        try {
            chain.doFilter(request, response);
        } catch (ServletException | IOException | RuntimeException | Error e) {
            failureStatus = HttpServletResponse.SC_INTERNAL_SERVER_ERROR;
            throw e;
        } finally {
            if (ACCESS.isInfoEnabled()) {
                int status = failureStatus != 0 && response.getStatus() < 400 ? failureStatus : response.getStatus();
                long millis = (System.nanoTime() - start) / 1_000_000;
                ACCESS.info("{} {} status={} duration={}ms user={} trace_id={}", request.getMethod(),
                        sanitizePath(request.getRequestURI()), status, millis, subject(request), traceId(response));
            }
        }
    }

    private static String subject(HttpServletRequest request) {
        Object value = request.getAttribute(SUBJECT_ATTRIBUTE);
        return value instanceof String s && UUID_SHAPE.matcher(s).matches() ? s : "-";
    }

    /** O trace id da resposta já foi validado pelo {@link TraceIdFilter}. */
    private static String traceId(HttpServletResponse response) {
        String id = response.getHeader(TraceIdFilter.HEADER);
        return id != null && !id.isEmpty() ? id : "-";
    }

    /** Mantém só ASCII imprimível (sem espaço), para que o caminho não injete quebras de linha nem controle. */
    private static String sanitizePath(String path) {
        if (path == null || path.isEmpty()) {
            return "-";
        }
        StringBuilder sb = new StringBuilder(path.length());
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            sb.append(c > 0x20 && c < 0x7f ? c : '?');
        }
        return sb.toString();
    }
}
