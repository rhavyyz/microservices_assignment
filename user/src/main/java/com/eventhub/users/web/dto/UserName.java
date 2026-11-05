package com.eventhub.users.web.dto;

import java.util.UUID;

import com.eventhub.users.user.User;

/** Consulta interna: somente id e nome. Registro dedicado para que nenhum outro campo vaze por acidente. */
public record UserName(UUID id, String name) {

    public static UserName from(User u) {
        return new UserName(u.getId(), u.getName());
    }
}
