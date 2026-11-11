package com.eventhub.users.web.dto;

import java.util.List;

import com.eventhub.users.user.User;

import org.springframework.data.domain.Page;

public record AdminUserPage(List<AdminUserItem> items, int page, int size, long totalElements, int totalPages) {

    public static AdminUserPage from(Page<User> p) {
        return new AdminUserPage(p.getContent().stream().map(AdminUserItem::from).toList(), p.getNumber(),
                p.getSize(), p.getTotalElements(), p.getTotalPages());
    }
}
