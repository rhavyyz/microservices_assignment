package com.microservices.discovery;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Dependency-free tests; exits non-zero on failure. Needs the env
 * SERVICE_DISCOVERER_URL=http://127.0.0.1:18099 and SERVICE_HOST=payments-1:9000
 * (see the Tests section of Libs/README.md).
 */
public class DiscoveryTest {
    static final AtomicReference<String> registered = new AtomicReference<>();
    static final AtomicReference<String> nextHost = new AtomicReference<>();
    static final AtomicInteger consults = new AtomicInteger();
    static final AtomicInteger consultStatus = new AtomicInteger(200);
    static final AtomicInteger registerCalls = new AtomicInteger();
    static final AtomicInteger registerFailures = new AtomicInteger();

    static String read(HttpExchange ex) throws Exception {
        return new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
    }

    static void reply(HttpExchange ex, int code, String body) throws Exception {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.sendResponseHeaders(code, b.length == 0 ? -1 : b.length);
        if (b.length > 0) ex.getResponseBody().write(b);
        ex.close();
    }

    static HttpServer serve(int port, Handler h) throws Exception {
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        s.createContext("/", ex -> {
            try { h.handle(ex); } catch (Exception e) { e.printStackTrace(); ex.close(); }
        });
        s.start();
        return s;
    }

    interface Handler { void handle(HttpExchange ex) throws Exception; }

    static String host(HttpServer s) { return "127.0.0.1:" + s.getAddress().getPort(); }

    static void check(boolean ok, String msg) {
        if (!ok) throw new AssertionError(msg);
    }

    public static void main(String[] args) throws Exception {
        serve(18099, ex -> {
            if (ex.getRequestMethod().equals("POST")) {
                registered.set(read(ex));
                if (registerCalls.incrementAndGet() <= registerFailures.get()) {
                    reply(ex, 503, "not ready");
                    return;
                }
                reply(ex, 204, "");
            } else {
                consults.incrementAndGet();
                if (consultStatus.get() != 200) { reply(ex, consultStatus.get(), "down"); return; }
                reply(ex, 200, "{\"host\":\"" + nextHost.get() + "\"}");
            }
        });
        HttpServer target = serve(0, ex -> reply(ex, 200,
                ex.getRequestHeaders().getFirst("X-Test") + "|" + ex.getRequestHeaders().getFirst("Content-Type") + "|" + read(ex)));

        // selfHost: SERVICE_HOST wins, else <hostname>:<PORT or 8080>
        check(Discovery.selfHost("svc-1:9000", "7000", "h").equals("svc-1:9000"), "selfHost SERVICE_HOST");
        check(Discovery.selfHost(null, "7000", "h").equals("h:7000"), "selfHost PORT");
        check(Discovery.selfHost("", "", "h").equals("h:8080"), "selfHost default port");
        check(Discovery.selfHost(null, null, "h").equals("h:8080"), "selfHost null port");
        check(Discovery.selfHost().equals("payments-1:9000"), "selfHost from env: " + Discovery.selfHost());

        // register sends the kind and the host
        Discovery.register(Kind.PAYMENTS);
        check("{\"kind\":\"payments\",\"host\":\"payments-1:9000\"}".equals(registered.get())
                || "{\"host\":\"payments-1:9000\",\"kind\":\"payments\"}".equals(registered.get()), "register body: " + registered.get());

        // register retries with exponential backoff (sleep is replaced, so no real waiting)
        List<Long> delays = new ArrayList<>();
        Discovery.sleeper = delays::add;
        registerCalls.set(0);
        registerFailures.set(3);
        Discovery.register(Kind.PAYMENTS);
        check(registerCalls.get() == 4, "register calls after 3 failures: " + registerCalls.get());
        check(delays.equals(List.of(1000L, 2000L, 4000L)), "delays after 3 failures: " + delays);

        delays.clear();
        registerCalls.set(0);
        registerFailures.set(1000);
        try {
            Discovery.register(Kind.PAYMENTS);
            check(false, "register should have failed");
        } catch (IOException e) {
            check(e.getMessage().startsWith("could not register with the service-discoverer: ")
                    && e.getMessage().contains("register failed: 503 not ready"), "message: " + e.getMessage());
        }
        check(registerCalls.get() == 10, "register calls when giving up: " + registerCalls.get());
        check(delays.equals(List.of(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L, 30000L, 30000L)),
                "delays when giving up: " + delays);
        registerFailures.set(0);

        // request: headers/body are sent and the host is cached
        nextHost.set(host(target));
        for (int i = 0; i < 3; i++) {
            HttpResponse<String> r = Discovery.request("POST", Kind.USER, "/x",
                    RequestOptions.of(Map.of("X-Test", "1"), Map.of("a", List.of(1, "b"))));
            check(r.body().equals("1|application/json|{\"a\":[1,\"b\"]}"), "response: " + r.body());
        }
        check(consults.get() == 1, "consults after cache: " + consults.get());

        // rediscovery: cached host dies, next call consults again and succeeds
        HttpServer second = serve(0, ex -> reply(ex, 200, "second"));
        target.stop(0);
        nextHost.set(host(second));
        HttpResponse<String> r = Discovery.request("GET", Kind.USER, "/x", null);
        check(r.body().equals("second"), "after rediscovery: " + r.body());
        check(consults.get() == 2, "consults after rediscovery: " + consults.get());

        // consult alone: asks every time, never caches
        nextHost.set("a:1");
        check(Discovery.consult(Kind.REPORTS).equals("a:1"), "consult a");
        nextHost.set("b:2");
        check(Discovery.consult(Kind.REPORTS).equals("b:2"), "consult b");
        check(consults.get() == 4, "consults after consult(): " + consults.get());

        // host cache TTL, with a fake clock (nanoseconds) and the ttl setting replaced
        AtomicLong now = new AtomicLong(1_000_000_000L);
        AtomicReference<String> ttl = new AtomicReference<>(null);
        Discovery.clock = now::get;
        Discovery.ttlSetting = ttl::get;
        long sec = 1_000_000_000L;
        HttpServer h1 = serve(0, ex -> reply(ex, 200, "h1"));
        HttpServer h2 = serve(0, ex -> reply(ex, 200, "h2"));

        // default 10s: reused within the TTL, a new consult after it moves to the next host
        int base = consults.get();
        nextHost.set(host(h1));
        check(Discovery.request("GET", Kind.CERTIFICATES, "/x", null).body().equals("h1"), "ttl first");
        now.addAndGet(9 * sec + sec / 2);
        check(Discovery.request("GET", Kind.CERTIFICATES, "/x", null).body().equals("h1"), "ttl within");
        check(consults.get() == base + 1, "consults within ttl: " + (consults.get() - base));
        nextHost.set(host(h2));
        now.addAndGet(sec);
        check(Discovery.request("GET", Kind.CERTIFICATES, "/x", null).body().equals("h2"), "ttl after expiry");
        check(consults.get() == base + 2, "consults after ttl: " + (consults.get() - base));

        // decimal ttl from the setting
        ttl.set("0.5");
        base = consults.get();
        nextHost.set(host(h1));
        now.addAndGet(sec); // expire the h2 entry
        Discovery.request("GET", Kind.EVENTS, "/x", null);
        now.addAndGet(sec * 4 / 10);
        Discovery.request("GET", Kind.EVENTS, "/x", null);
        check(consults.get() == base + 1, "consults within 0.5s: " + (consults.get() - base));
        now.addAndGet(sec / 5);
        Discovery.request("GET", Kind.EVENTS, "/x", null);
        check(consults.get() == base + 2, "consults after 0.5s: " + (consults.get() - base));

        // ttl 0: consult before every request
        ttl.set("0");
        base = consults.get();
        for (int i = 0; i < 3; i++) Discovery.request("GET", Kind.NOTIFICATIONS, "/x", null);
        check(consults.get() == base + 3, "consults with ttl 0: " + (consults.get() - base));

        // invalid settings give the default 10s
        for (String bad : new String[] {null, "", "abc", "-1", "NaN", "Infinity", "-Infinity"}) {
            check(Discovery.parseTtlSeconds(bad) == 10.0, "invalid ttl " + bad);
        }
        check(Discovery.parseTtlSeconds("2.5") == 2.5 && Discovery.parseTtlSeconds("0") == 0.0, "valid ttl");
        ttl.set("junk");
        base = consults.get();
        Discovery.request("GET", Kind.SUBSCRIPTION, "/x", null);
        now.addAndGet(9 * sec);
        Discovery.request("GET", Kind.SUBSCRIPTION, "/x", null);
        check(consults.get() == base + 1, "invalid ttl within 10s: " + (consults.get() - base));
        now.addAndGet(2 * sec);
        Discovery.request("GET", Kind.SUBSCRIPTION, "/x", null);
        check(consults.get() == base + 2, "invalid ttl after 10s: " + (consults.get() - base));

        // stale host reused when the refresh fails; nothing cached still throws
        ttl.set(null);
        consultStatus.set(503);
        try {
            Discovery.request("GET", Kind.PAYMENTS, "/x", null);
            check(false, "nothing cached should throw");
        } catch (IOException e) {
            check(e.getMessage().contains("consult payments failed: 503"), "message: " + e.getMessage());
        }
        consultStatus.set(200);
        nextHost.set(host(h1));
        Discovery.request("GET", Kind.PAYMENTS, "/x", null);
        now.addAndGet(11 * sec);
        consultStatus.set(503);
        base = consults.get();
        check(Discovery.request("GET", Kind.PAYMENTS, "/x", null).body().equals("h1"), "stale host reused");
        check(consults.get() == base + 1, "refresh attempted: " + (consults.get() - base));
        Discovery.request("GET", Kind.PAYMENTS, "/x", null);
        check(consults.get() == base + 2, "refresh retried while expired: " + (consults.get() - base));

        // rediscovery after failure still works, resets the TTL, and a failing rediscovery throws
        consultStatus.set(200);
        HttpServer dying = serve(0, ex -> reply(ex, 200, "dying"));
        nextHost.set(host(dying));
        Discovery.request("GET", Kind.REPORTS, "/x", null);
        dying.stop(0);
        nextHost.set(host(h2));
        base = consults.get();
        check(Discovery.request("GET", Kind.REPORTS, "/x", null).body().equals("h2"), "rediscovered");
        check(consults.get() == base + 1, "rediscovery consult: " + (consults.get() - base));
        now.addAndGet(9 * sec);
        Discovery.request("GET", Kind.REPORTS, "/x", null);
        check(consults.get() == base + 1, "ttl reset by rediscovery");
        h2.stop(0);
        consultStatus.set(503);
        try {
            Discovery.request("GET", Kind.REPORTS, "/x", null);
            check(false, "failing rediscovery should throw");
        } catch (IOException e) {
            check(e.getMessage().contains("consult reports failed: 503"), "message: " + e.getMessage());
        }

        System.out.println("OK");
        System.exit(0);
    }
}
