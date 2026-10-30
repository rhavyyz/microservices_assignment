package com.microservices.discovery;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
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
                reply(ex, 204, "");
            } else {
                consults.incrementAndGet();
                reply(ex, 200, "{\"host\":\"" + nextHost.get() + "\"}");
            }
        });
        HttpServer target = serve(0, ex -> reply(ex, 200,
                ex.getRequestHeaders().getFirst("X-Test") + "|" + ex.getRequestHeaders().getFirst("Content-Type") + "|" + read(ex)));

        // register sends the kind and the host
        Discovery.register(Kind.PAYMENTS);
        check("{\"kind\":\"payments\",\"host\":\"payments-1:9000\"}".equals(registered.get())
                || "{\"host\":\"payments-1:9000\",\"kind\":\"payments\"}".equals(registered.get()), "register body: " + registered.get());

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

        System.out.println("OK");
        System.exit(0);
    }
}
