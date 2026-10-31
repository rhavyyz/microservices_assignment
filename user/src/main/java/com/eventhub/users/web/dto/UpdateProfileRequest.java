package com.eventhub.users.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Único campo editável no perfil comum. E-mail, senha e papéis exigem fluxos próprios (fora do escopo). */
public record UpdateProfileRequest(
        @NotBlank(message = "Informe o nome.")
        @Size(max = 120, message = "O nome deve ter no máximo 120 caracteres.")
        String name) {
}
