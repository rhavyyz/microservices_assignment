package com.eventhub.users.web.dto;

import java.util.List;
import java.util.UUID;

import com.eventhub.users.user.Role;
import com.eventhub.users.user.User;
import com.eventhub.users.user.UserStatus;

/** Item da busca de usuários. Sem hash de senha, sem datas internas. */
public record UserListItem(UUID id, String name, String email, List<Role> roles, UserStatus status) {

    public static UserListItem from(User u) {
        return new UserListItem(u.getId(), u.getName(), u.getEmail(), u.getRoles().stream().sorted().toList(),
                u.getStatus());
    }
}
