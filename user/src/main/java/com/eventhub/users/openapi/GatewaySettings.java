package com.eventhub.users.openapi;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Settings the Gateway seeds for this operation on first insert; published in the OpenAPI as the operation's
 * {@code x-gateway} extension (see {@link GatewayOpenApiConfig}). Has no effect on the endpoint itself.
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface GatewaySettings {

    boolean isPublic();

    boolean requireAuth();

    /** Requests per minute the Gateway allows; {@code -1} leaves the Gateway default. */
    int maxPerMin() default -1;

    /** {@code user_or_ip}, {@code ip} or {@code global}; empty leaves the Gateway default. */
    String rateLimitBy() default "";
}
