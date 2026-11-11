package com.eventhub.users.web;

import java.util.UUID;

import com.eventhub.users.openapi.GatewaySettings;
import com.eventhub.users.user.UserService;
import com.eventhub.users.web.dto.UserPage;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Busca de usuários por {@code id} (exato), {@code email} (contém) e {@code name} (contém). Somente ORGANIZER.
 * Filtros combinam com AND; ao menos um é obrigatório; resultado paginado e ordenado por nome.
 */
@RestController
@RequestMapping("/api/v1/users")
public class UserSearchController {

    private final UserService users;

    public UserSearchController(UserService users) {
        this.users = users;
    }

    @GatewaySettings(isPublic = true, requireAuth = true, maxPerMin = 60, rateLimitBy = "user_or_ip")
    @GetMapping
    public UserPage search(
            @AuthenticationPrincipal Jwt jwt,
            @RequestParam(required = false) UUID id,
            @RequestParam(required = false) String email,
            @RequestParam(required = false) String name,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        UUID requester;
        try {
            requester = UUID.fromString(jwt.getSubject());
        } catch (IllegalArgumentException | NullPointerException e) {
            throw ApiException.unauthenticated();
        }
        return UserPage.from(users.search(requester, id, email, name, page, size));
    }
}
