package com.eventhub.users.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record LoginRequest(
        @NotBlank(message = "Informe o e-mail.")
        @Size(max = 254, message = "O e-mail deve ter no máximo 254 caracteres.")
        String email,

        // Limite superior apenas para não permitir hashing de entradas gigantes; a política fica no cadastro.
        @NotBlank(message = "Informe a senha.")
        @Size(max = 128, message = "A senha é muito longa.")
        String password) {

    @Override
    public String toString() {
        return "LoginRequest[email=" + email + ", password=***]";
    }
}
