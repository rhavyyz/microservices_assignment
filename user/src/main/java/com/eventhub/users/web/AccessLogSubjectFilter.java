package com.eventhub.users.web;

import java.io.IOException;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Filtro da cadeia de segurança, depois da autenticação Bearer: guarda o {@code sub} do JWT em um atributo da
 * requisição para o {@link AccessLogFilter}, que escreve a linha quando o SecurityContext já foi limpo.
 * Não é um bean: é adicionado explicitamente ao {@code SecurityFilterChain}.
 */
public class AccessLogSubjectFilter implements Filter {

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && auth.getPrincipal() instanceof Jwt jwt
                && jwt.getSubject() != null) {
            request.setAttribute(AccessLogFilter.SUBJECT_ATTRIBUTE, jwt.getSubject());
        }
        chain.doFilter(request, response);
    }
}
