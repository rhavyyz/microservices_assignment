package com.eventhub.users.web;

import java.util.UUID;

import com.eventhub.users.openapi.GatewaySettings;
import com.eventhub.users.user.UserService;
import com.eventhub.users.web.dto.AdminUserItem;
import com.eventhub.users.web.dto.AdminUserPage;
import com.eventhub.users.web.dto.OrganizerDecisionRequest;

import jakarta.validation.Valid;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Área do ADMIN: lista todos os usuários (com a situação do pedido de organizador) e decide quem é organizador.
 * O papel ADMIN é exigido na configuração de segurança e conferido de novo no banco pelo serviço.
 */
@RestController
@RequestMapping("/api/v1/admin/users")
public class AdminUserController {

    private final UserService users;

    public AdminUserController(UserService users) {
        this.users = users;
    }

    @GatewaySettings(isPublic = true, requireAuth = true, maxPerMin = 60, rateLimitBy = "user_or_ip")
    @GetMapping
    public AdminUserPage list(
            @AuthenticationPrincipal Jwt jwt,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String organizerRequest,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return AdminUserPage.from(users.adminList(subject(jwt), q, organizerRequest, page, size));
    }

    @GatewaySettings(isPublic = true, requireAuth = true, maxPerMin = 30, rateLimitBy = "user_or_ip")
    @PutMapping("/{id}/organizer")
    public AdminUserItem decideOrganizer(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID id,
            @Valid @RequestBody OrganizerDecisionRequest request) {
        return AdminUserItem.from(users.decideOrganizer(subject(jwt), id, request.approved()));
    }

    private static UUID subject(Jwt jwt) {
        try {
            return UUID.fromString(jwt.getSubject());
        } catch (IllegalArgumentException | NullPointerException e) {
            throw ApiException.unauthenticated();
        }
    }
}
