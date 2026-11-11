package com.eventhub.users.openapi;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springdoc.core.customizers.OperationCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Adds {@code x-gateway: {isPublic, requireAuth[, maxPerMin, rateLimitBy]}} to every operation annotated with {@link GatewaySettings}. */
@Configuration
public class GatewayOpenApiConfig {

    @Bean
    OperationCustomizer gatewayExtension() {
        return (operation, handlerMethod) -> {
            GatewaySettings settings = handlerMethod.getMethodAnnotation(GatewaySettings.class);
            if (settings != null) {
                Map<String, Object> ext = new LinkedHashMap<>();
                ext.put("isPublic", settings.isPublic());
                ext.put("requireAuth", settings.requireAuth());
                if (settings.maxPerMin() >= 0) {
                    ext.put("maxPerMin", settings.maxPerMin());
                }
                if (!settings.rateLimitBy().isEmpty()) {
                    ext.put("rateLimitBy", settings.rateLimitBy());
                }
                operation.addExtension("x-gateway", ext);
            }
            return operation;
        };
    }
}
