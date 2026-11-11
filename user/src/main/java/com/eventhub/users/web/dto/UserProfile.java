package com.eventhub.users.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.eventhub.users.user.OrganizerRequest;
import com.eventhub.users.user.Role;
import com.eventhub.users.user.User;

/** Dados públicos da conta. Não existe campo para hash de senha: ele não tem como vazar por este tipo. */
public record UserProfile(UUID id, String name, String email, List<Role> roles, OrganizerRequest organizerRequest,
        Instant createdAt, Instant updatedAt) {

    public static UserProfile from(User u) {
        return new UserProfile(u.getId(), u.getName(), u.getEmail(), u.getRoles().stream().sorted().toList(),
                u.getOrganizerRequest(), u.getCreatedAt(), u.getUpdatedAt());
    }
}
