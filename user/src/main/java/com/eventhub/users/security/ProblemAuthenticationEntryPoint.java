package com.eventhub.users.security;

import java.io.IOException;

import com.eventhub.users.audit.AuditLogger;
import com.eventhub.users.audit.AuditLogger.Operation;
import com.eventhub.users.audit.AuditLogger.Result;
import com.eventhub.users.web.Problems;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.HttpHeaders;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.stereotype.Component;

/** 401 uniforme para token ausente, inválido, expirado ou de emissor não confiável. */
@Component
class ProblemAuthenticationEntryPoint implements AuthenticationEntryPoint {

    private final AuditLogger audit;

    ProblemAuthenticationEntryPoint(AuditLogger audit) {
        this.audit = audit;
    }

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response, AuthenticationException ex)
            throws IOException {
        // Registra só o fato (nunca o valor do cabeçalho Authorization) e apenas quando um token foi apresentado.
        if (request.getHeader(HttpHeaders.AUTHORIZATION) != null) {
            audit.record(Operation.TOKEN_REJECTED, Result.FAILURE, null, null);
        }
        response.setHeader(HttpHeaders.WWW_AUTHENTICATE, "Bearer");
        Problems.write(response, 401, "Não autenticado", "Sessão ausente, inválida ou expirada.", "UNAUTHENTICATED");
    }
}
