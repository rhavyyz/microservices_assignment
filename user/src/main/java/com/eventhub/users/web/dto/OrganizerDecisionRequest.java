package com.eventhub.users.web.dto;

import jakarta.validation.constraints.NotNull;

/** Decisão do ADMIN: {@code approved=true} concede o papel ORGANIZER; {@code false} nega o pedido ou o retira. */
public record OrganizerDecisionRequest(
        @NotNull(message = "Informe a decisão (approved: true ou false).")
        Boolean approved) {
}
