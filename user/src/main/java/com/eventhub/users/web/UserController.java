package com.eventhub.users.web;

import java.util.UUID;

import com.eventhub.users.openapi.GatewaySettings;
import com.eventhub.users.user.UserService;
import com.eventhub.users.web.dto.UpdateProfileRequest;
import com.eventhub.users.web.dto.UserProfile;

import jakarta.validation.Valid;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Perfil do usuário autenticado. Não há {@code {id}} no caminho nem no corpo: a identidade vem somente do
 * claim {@code sub} do token validado, o que impede acesso ao perfil de terceiros (RN07).
 */
@RestController
@RequestMapping("/api/v1/users/me")
public class UserController {

    private final UserService users;

    public UserController(UserService users) {
        this.users = users;
    }

    @GatewaySettings(isPublic = true, requireAuth = true)
    @GetMapping
    public UserProfile me(@AuthenticationPrincipal Jwt jwt) {
        return UserProfile.from(users.getActive(subject(jwt)));
    }

    @GatewaySettings(isPublic = true, requireAuth = true)
    @PatchMapping
    public UserProfile update(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody UpdateProfileRequest request) {
        return UserProfile.from(users.updateName(subject(jwt), request.name()));
    }

    private static UUID subject(Jwt jwt) {
        try {
            return UUID.fromString(jwt.getSubject());
        } catch (IllegalArgumentException | NullPointerException e) {
            throw ApiException.unauthenticated();
        }
    }
}
