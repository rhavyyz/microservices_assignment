package com.eventhub.users.web;

import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.ErrorResponse;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** Mapeia exceções para o formato de erro único. Detalhes internos só vão para o log, com o traceId. */
@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Logger LOG = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    ResponseEntity<String> handleApi(ApiException ex) {
        return Problems.response(ex.status().value(), ex.title(), ex.getMessage(), ex.code(), ex.errors());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<String> handleValidation(MethodArgumentNotValidException ex) {
        // Somente nome do campo e a mensagem das nossas anotações: o valor rejeitado (ex.: senha) nunca é ecoado.
        List<Problems.FieldIssue> issues = ex.getBindingResult().getFieldErrors().stream()
                .map(e -> new Problems.FieldIssue(e.getField(), e.getDefaultMessage()))
                .toList();
        return Problems.response(400, "Dados inválidos", "Verifique os campos enviados.", "VALIDATION_ERROR", issues);
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<String> handleUnreadable(HttpMessageNotReadableException ex) {
        // Cobre JSON inválido e campos desconhecidos (ex.: "roles" no cadastro). A causa não é devolvida ao cliente.
        return Problems.response(400, "Requisição malformada",
                "O corpo da requisição é inválido ou contém campos não permitidos.", "MALFORMED_REQUEST", null);
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<String> handleAny(Exception ex) {
        if (ex instanceof ErrorResponse er && er.getStatusCode().value() < 500) {
            int status = er.getStatusCode().value();
            return switch (status) {
                case 404 -> Problems.response(404, "Recurso não encontrado", "O recurso solicitado não existe.",
                        "NOT_FOUND", null);
                case 405 -> Problems.response(405, "Método não permitido",
                        "O método HTTP não é permitido para este recurso.", "HTTP_405", null);
                case 415 -> Problems.response(415, "Tipo de conteúdo não suportado",
                        "Envie o corpo como application/json.", "HTTP_415", null);
                default -> Problems.response(status, "Requisição inválida", "A requisição não pôde ser processada.",
                        "HTTP_" + status, null);
            };
        }
        LOG.error("Unhandled exception", ex); // stack trace apenas no log, correlacionado pelo traceId do MDC
        return Problems.response(500, "Erro interno",
                "Ocorreu um erro inesperado. Informe o identificador ao suporte.", "INTERNAL_ERROR", null);
    }
}
