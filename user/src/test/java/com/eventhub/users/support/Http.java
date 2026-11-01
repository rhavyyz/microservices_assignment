package com.eventhub.users.support;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import com.jayway.jsonpath.JsonPath;

/** Cliente HTTP mínimo (JDK) para os testes de integração: exercita a pilha servlet real, com filtros. */
public final class Http {

    public record Result(int status, String body, HttpHeaders headers) {
        public String header(String name) {
            return headers.firstValue(name).orElse(null);
        }

        public <T> T json(String path) {
            return JsonPath.read(body, path);
        }
    }

    private final String base;
    private final HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();

    public Http(int port) {
        this.base = "http://localhost:" + port;
    }

    public Result send(String method, String path, String json, String bearer, String... extraHeaders) {
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path));
            if (json != null) {
                b.header("Content-Type", "application/json");
            }
            if (bearer != null) {
                b.header("Authorization", "Bearer " + bearer);
            }
            for (int i = 0; i + 1 < extraHeaders.length; i += 2) {
                b.header(extraHeaders[i], extraHeaders[i + 1]);
            }
            b.method(method, json == null ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(json));
            HttpResponse<String> r = client.send(b.build(), HttpResponse.BodyHandlers.ofString());
            return new Result(r.statusCode(), r.body(), r.headers());
        } catch (java.io.IOException | InterruptedException e) {
            throw new IllegalStateException(e);
        }
    }

    public Result get(String path, String bearer) {
        return send("GET", path, null, bearer);
    }

    public Result post(String path, String json) {
        return send("POST", path, json, null);
    }
}
