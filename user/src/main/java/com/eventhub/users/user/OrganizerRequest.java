package com.eventhub.users.user;

/**
 * Situação do pedido de organizador. NONE: nunca pediu; PENDING: escolheu "organizador" no cadastro e aguarda;
 * APPROVED: um ADMIN concedeu o papel; DENIED: um ADMIN negou ou retirou o papel.
 */
public enum OrganizerRequest {
    NONE,
    PENDING,
    APPROVED,
    DENIED
}
