package com.eventhub.users.web;

import java.util.UUID;

import com.eventhub.users.openapi.GatewaySettings;
import com.eventhub.users.user.UserService;
import com.eventhub.users.web.dto.UserName;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Consulta interna do nome de exibição, para outros serviços (ex.: Certificados) sem token de usuário.
 * Sem autenticação: a proteção é o isolamento de rede, e o Gateway nunca deve expor esta rota.
 * Devolve somente {@code id} e {@code name}.
 */
@RestController
@RequestMapping("/internal/users")
public class InternalUserController {

    private final UserService users;

    public InternalUserController(UserService users) {
        this.users = users;
    }

    @GatewaySettings(isPublic = false, requireAuth = false)
    @GetMapping("/{id}")
    public UserName name(@PathVariable UUID id) {
        return UserName.from(users.getName(id));
    }
}
