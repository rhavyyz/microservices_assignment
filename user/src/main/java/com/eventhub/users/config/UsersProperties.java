package com.eventhub.users.config;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Configuração externa do serviço (prefixo {@code users}). Nenhum segredo tem valor padrão aqui:
 * a chave privada vem de arquivo montado como segredo (DT-01).
 */
@Validated
@ConfigurationProperties(prefix = "users")
public record UsersProperties(
        @NotNull Jwt jwt,
        @NotNull Password password,
        @NotNull DevSeed devSeed,
        @NotNull AdminBootstrap adminBootstrap,
        @NotNull Discovery discovery) {

    /**
     * @param issuer         valor da claim {@code iss}
     * @param keyId          {@code kid} publicado no JWKS
     * @param privateKeyFile PEM PKCS#8 (RSA, 2048 bits ou mais) da chave de assinatura
     * @param ttlSeconds     validade do Access Token, em segundos
     */
    public record Jwt(
            @NotBlank String issuer,
            @NotBlank String keyId,
            @NotBlank String privateKeyFile,
            @Min(60) long ttlSeconds) {
    }

    /** @param bcryptStrength fator de custo do BCrypt (OWASP recomenda 10 ou mais; testes usam o mínimo, 4) */
    public record Password(@Min(4) @Max(31) int bcryptStrength) {
    }

    /** Organizador de demonstração para ambiente local. Desativado por padrão (DT-02). */
    public record DevSeed(boolean enabled, String name, String email, String password) {
    }

    /**
     * Primeiro administrador (DT-11): único caminho para criar um ADMIN, porque nenhuma rota HTTP concede o papel.
     * Desativado por padrão; as credenciais vêm só do ambiente.
     */
    public record AdminBootstrap(boolean enabled, String name, String email, String password) {
    }

    /**
     * @param enabled           registra a instância no service-discoverer
     * @param reregisterSeconds intervalo do re-registro (o registro do discoverer é em memória)
     */
    public record Discovery(boolean enabled, @Min(5) long reregisterSeconds) {
    }
}
