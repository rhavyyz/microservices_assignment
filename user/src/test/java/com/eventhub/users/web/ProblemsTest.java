package com.eventhub.users.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;

import com.jayway.jsonpath.JsonPath;

import org.junit.jupiter.api.Test;
import org.slf4j.MDC;

class ProblemsTest {

    @Test
    void producesValidJsonWithCodeTraceIdAndEscaping() {
        MDC.put(TraceIdFilter.MDC_KEY, "trace-12345678");
        try {
            String json = Problems.json(400, "Dados \"inválidos\"", "linha1\nlinha2\\", "VALIDATION_ERROR",
                    List.of(new Problems.FieldIssue("email", "Informe um e-mail válido.")));
            assertThat(JsonPath.<String>read(json, "$.code")).isEqualTo("VALIDATION_ERROR");
            assertThat(JsonPath.<String>read(json, "$.traceId")).isEqualTo("trace-12345678");
            assertThat(JsonPath.<Integer>read(json, "$.status")).isEqualTo(400);
            assertThat(JsonPath.<String>read(json, "$.title")).isEqualTo("Dados \"inválidos\"");
            assertThat(JsonPath.<String>read(json, "$.detail")).isEqualTo("linha1\nlinha2\\");
            assertThat(JsonPath.<String>read(json, "$.errors[0].field")).isEqualTo("email");
        } finally {
            MDC.remove(TraceIdFilter.MDC_KEY);
        }
    }
}
