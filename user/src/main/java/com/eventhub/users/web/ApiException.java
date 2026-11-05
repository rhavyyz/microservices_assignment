package com.eventhub.users.web;

import java.util.List;

import org.springframework.http.HttpStatus;

/** Erro de negócio com status HTTP, código estável de aplicação e mensagem segura para o cliente. */
public class ApiException extends RuntimeException {

    private final HttpStatus status;
    private final String code;
    private final String title;
    private final List<Problems.FieldIssue> errors;

    private ApiException(HttpStatus status, String code, String title, String detail,
            List<Problems.FieldIssue> errors) {
        super(detail);
        this.status = status;
        this.code = code;
        this.title = title;
        this.errors = errors;
    }

    public static ApiException validation(String field, String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Dados inválidos",
                "Verifique os campos enviados.", List.of(new Problems.FieldIssue(field, message)));
    }

    public static ApiException emailAlreadyRegistered() {
        return new ApiException(HttpStatus.CONFLICT, "EMAIL_ALREADY_REGISTERED", "E-mail já cadastrado",
                "Não foi possível concluir o cadastro com este e-mail.", null);
    }

    /** Mensagem genérica: nunca indica se o e-mail existe (RN do prompt, 6.2.6). */
    public static ApiException invalidCredentials() {
        return new ApiException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "Credenciais inválidas",
                "E-mail ou senha incorretos.", null);
    }

    public static ApiException unauthenticated() {
        return new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Não autenticado",
                "Sessão ausente, inválida ou expirada.", null);
    }

    public static ApiException accountInactive() {
        return new ApiException(HttpStatus.FORBIDDEN, "ACCESS_DENIED", "Acesso negado",
                "Você não tem permissão para esta operação.", null);
    }

    public static ApiException forbidden() {
        return new ApiException(HttpStatus.FORBIDDEN, "ACCESS_DENIED", "Acesso negado",
                "Você não tem permissão para esta operação.", null);
    }

    public static ApiException userNotFound() {
        return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Usuário não encontrado",
                "O usuário da sessão não existe mais.", null);
    }

    public HttpStatus status() {
        return status;
    }

    public String code() {
        return code;
    }

    public String title() {
        return title;
    }

    public List<Problems.FieldIssue> errors() {
        return errors;
    }
}
