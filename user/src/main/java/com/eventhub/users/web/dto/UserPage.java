package com.eventhub.users.web.dto;

import java.util.List;

import com.eventhub.users.user.User;

import org.springframework.data.domain.Page;

/** Página de resultados com formato próprio (estável), em vez de serializar o PageImpl do Spring Data. */
public record UserPage(List<UserListItem> items, int page, int size, long totalElements, int totalPages) {

    public static UserPage from(Page<User> p) {
        return new UserPage(p.getContent().stream().map(UserListItem::from).toList(), p.getNumber(), p.getSize(),
                p.getTotalElements(), p.getTotalPages());
    }
}
