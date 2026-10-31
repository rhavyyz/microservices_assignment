package com.eventhub.users.security;

import java.io.IOException;

import com.eventhub.users.audit.AuditLogger;
import com.eventhub.users.audit.AuditLogger.Operation;
import com.eventhub.users.audit.AuditLogger.Result;
import com.eventhub.users.web.Problems;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;

/** 403 uniforme para usuário autenticado sem permissão. */
@Component
class ProblemAccessDeniedHandler implements AccessDeniedHandler {

    private final AuditLogger audit;

    ProblemAccessDeniedHandler(AuditLogger audit) {
        this.audit = audit;
    }

    @Override
    public void handle(HttpServletRequest request, HttpServletResponse response, AccessDeniedException ex)
            throws IOException {
        audit.record(Operation.ACCESS_DENIED, Result.FAILURE, null, null);
        Problems.write(response, 403, "Acesso negado", "Você não tem permissão para esta operação.", "ACCESS_DENIED");
    }
}
