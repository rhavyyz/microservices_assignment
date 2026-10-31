package com.microservices.discovery;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Registers this instance with the service-discoverer and calls other services
 * by kind, caching the discovered host per kind.
 */
public final class Discovery {
    private static final int REGISTER_ATTEMPTS = 10;
    private static final long REGISTER_INITIAL_DELAY_MS = 1000;
    private static final long REGISTER_MAX_DELAY_MS = 30_000;
    private static final Pattern HOST = Pattern.compile("\"host\"\\s*:\\s*\"([^\"]+)\"");

    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();

    /** One cache per kind. The kinds are fixed, so the map never changes. */
    private static final Map<Kind, KindCache> CACHES = new EnumMap<>(Kind.class);

    static {
        for (Kind k : Kind.values()) CACHES.put(k, new KindCache());
    }

    private static final class KindCache {
        final ReentrantLock lock = new ReentrantLock();
        String host;
    }

    /** Sleeps between register attempts; package-private so tests can replace it. */
    interface Sleeper { void sleep(long millis) throws InterruptedException; }

    static Sleeper sleeper = Thread::sleep;

    private Discovery() {}

    private static String discovererUrl() {
        String u = System.getenv("SERVICE_DISCOVERER_URL");
        if (u == null || u.isEmpty()) u = "http://service-discoverer:8080";
        return u.endsWith("/") ? u.substring(0, u.length() - 1) : u;
    }

    /**
     * Registers this instance. Call once at startup, passing only its own kind.
     * The host sent is SERVICE_HOST, or "&lt;hostname&gt;:&lt;PORT or 8080&gt;".
     * Retries up to 10 times with a delay doubling from 1s up to 30s (about 2.5
     * minutes in all), so it blocks meanwhile: call it from a thread if the
     * service must not wait.
     */
    public static void register(Kind kind) throws IOException, InterruptedException {
        String host = System.getenv("SERVICE_HOST");
        if (host == null || host.isEmpty()) {
            String port = System.getenv("PORT");
            host = InetAddress.getLocalHost().getHostName() + ":" + (port == null || port.isEmpty() ? "8080" : port);
        }
        String payload = Json.write(Map.of("kind", kind.value(), "host", host));
        HttpRequest req = HttpRequest.newBuilder(URI.create(discovererUrl() + "/register"))
                .timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload)).build();

        Exception last = null;
        long delay = REGISTER_INITIAL_DELAY_MS;
        for (int i = 0; i < REGISTER_ATTEMPTS; i++) {
            if (i > 0) {
                sleeper.sleep(delay);
                delay = Math.min(delay * 2, REGISTER_MAX_DELAY_MS);
            }
            try {
                HttpResponse<String> res = CLIENT.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() >= 200 && res.statusCode() < 300) return;
                last = new IOException("register failed: " + res.statusCode() + " " + res.body().trim());
            } catch (IOException e) {
                last = e;
            }
        }
        throw new IOException("could not register with the service-discoverer: " + last, last);
    }

    /** Asks the service-discoverer for a healthy host of {@code kind}. No caching. */
    public static String consult(Kind kind) throws IOException, InterruptedException {
        String q = URLEncoder.encode(kind.value(), StandardCharsets.UTF_8);
        HttpRequest req = HttpRequest.newBuilder(URI.create(discovererUrl() + "/consult?kind=" + q))
                .timeout(Duration.ofSeconds(15)).GET().build();
        HttpResponse<String> res = CLIENT.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 200) {
            throw new IOException("consult " + kind.value() + " failed: " + res.statusCode() + " " + res.body().trim());
        }
        Matcher m = HOST.matcher(res.body());
        if (!m.find()) throw new IOException("bad consult response: " + res.body());
        return m.group(1);
    }

    /** Returns the cached host, calling {@link #consult} if there is none or it is {@code stale}. */
    private static String resolve(Kind kind, String stale) throws IOException, InterruptedException {
        KindCache c = CACHES.get(kind);
        c.lock.lock();
        try {
            if (c.host == null || c.host.equals(stale)) {
                c.host = consult(kind);
            }
            return c.host;
        } finally {
            c.lock.unlock();
        }
    }

    /**
     * Calls {@code url} (a path like "/charge") on an instance of {@code kind}.
     * If the cached host is unreachable, the host is rediscovered and the call
     * retried once. HTTP error statuses are returned, not thrown.
     */
    public static HttpResponse<String> request(String method, Kind kind, String url, RequestOptions options)
            throws IOException, InterruptedException {
        RequestOptions opts = options == null ? RequestOptions.none() : options;
        String path = url.startsWith("/") ? url : "/" + url;
        String json = opts.body() == null ? null : Json.write(opts.body());

        String host = resolve(kind, null);
        try {
            return send(method, host, path, opts, json);
        } catch (IOException unreachable) { // refused, timeout, DNS
            host = resolve(kind, host);
            return send(method, host, path, opts, json);
        }
    }

    private static HttpResponse<String> send(String method, String host, String path, RequestOptions opts, String json)
            throws IOException, InterruptedException {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://" + host + path))
                .timeout(Duration.ofSeconds(5));
        opts.headers().forEach(b::header);
        if (json != null && opts.headers().keySet().stream().noneMatch(h -> h.equalsIgnoreCase("Content-Type"))) {
            b.header("Content-Type", "application/json");
        }
        b.method(method.toUpperCase(), json == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(json));
        return CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }
}
