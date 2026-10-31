package com.eventhub.users.web.dto;

import java.util.List;
import java.util.UUID;

import com.eventhub.users.user.Role;
import com.eventhub.users.user.User;

public record UserSummary(UUID id, String name, String email, List<Role> roles) {

    public static UserSummary from(User u) {
        return new UserSummary(u.getId(), u.getName(), u.getEmail(), u.getRoles().stream().sorted().toList());
    }
}
