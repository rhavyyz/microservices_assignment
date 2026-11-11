package com.eventhub.users.user;

/**
 * Papéis controlados. ORGANIZER não dá acesso a todos os eventos: isso é validado pelo serviço de Eventos (RN07).
 * ADMIN decide quem é organizador e lista os usuários; não é concedido por nenhuma rota HTTP.
 */
public enum Role {
    PARTICIPANT,
    ORGANIZER,
    ADMIN
}
