package com.eventhub.users.user;

/** Papéis controlados. ORGANIZER não dá acesso a todos os eventos: isso é validado pelo serviço de Eventos (RN07). */
public enum Role {
    PARTICIPANT,
    ORGANIZER
}
