package com.eventhub.users.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Cadastro público. Só existem estes quatro campos: qualquer outro (roles, isAdmin...) é rejeitado
 * na desserialização (400 MALFORMED_REQUEST) e, de qualquer forma, nunca é lido. {@code requestedRole} é opcional
 * (PARTICIPANT por padrão) e <b>não concede</b> papel algum: ORGANIZER vira apenas um pedido pendente.
 */
public record RegisterRequest(
        @NotBlank(message = "Informe o nome.")
        @Size(max = 120, message = "O nome deve ter no máximo 120 caracteres.")
        String name,

        @NotBlank(message = "Informe o e-mail.")
        @Size(max = 254, message = "O e-mail deve ter no máximo 254 caracteres.")
        @Pattern(regexp = Patterns.EMAIL, message = "Informe um e-mail válido.")
        String email,

        @NotBlank(message = "Informe a senha.")
        @Size(min = 10, max = 72, message = "A senha deve ter entre 10 e 72 caracteres.")
        String password,

        @Pattern(regexp = "PARTICIPANT|ORGANIZER", message = "Use PARTICIPANT ou ORGANIZER.")
        String requestedRole) {

    /** Quem escolheu "organizador" só abre um pedido: o papel é concedido por um ADMIN (ADR-009). */
    public boolean wantsOrganizer() {
        return "ORGANIZER".equals(requestedRole);
    }

    @Override
    public String toString() {
        return "RegisterRequest[name=" + name + ", email=" + email + ", password=***]";
    }
}
