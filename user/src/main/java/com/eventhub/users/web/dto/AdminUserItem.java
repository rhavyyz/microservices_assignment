package com.eventhub.users.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.eventhub.users.user.OrganizerRequest;
import com.eventhub.users.user.Role;
import com.eventhub.users.user.User;
import com.eventhub.users.user.UserStatus;

/** Item da listagem do ADMIN: quem é, quais papéis tem e em que pé está o pedido de organizador. Sem hash de senha. */
public record AdminUserItem(UUID id, String name, String email, List<Role> roles, UserStatus status,
        OrganizerRequest organizerRequest, Instant organizerRequestUpdatedAt, Instant createdAt) {

    public static AdminUserItem from(User u) {
        return new AdminUserItem(u.getId(), u.getName(), u.getEmail(), u.getRoles().stream().sorted().toList(),
                u.getStatus(), u.getOrganizerRequest(), u.getOrganizerRequestUpdatedAt(), u.getCreatedAt());
    }
}
