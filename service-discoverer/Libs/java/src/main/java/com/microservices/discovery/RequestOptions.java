package com.microservices.discovery;

import java.util.HashMap;
import java.util.Map;

/**
 * Optional headers and JSON body of a request. The body can be a Map, List,
 * String, Number, Boolean or null (nested freely).
 */
public record RequestOptions(Map<String, String> headers, Object body) {
    public RequestOptions {
        headers = headers == null ? new HashMap<>() : new HashMap<>(headers);
    }

    public static RequestOptions none() {
        return new RequestOptions(null, null);
    }

    public static RequestOptions of(Map<String, String> headers, Object body) {
        return new RequestOptions(headers, body);
    }
}
