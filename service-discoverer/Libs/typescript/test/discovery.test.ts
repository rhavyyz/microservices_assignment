import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { test } from "node:test";
import { Kind, consult, createClient, register, request } from "../src/index.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
type Handler = (call: Call) => Response | Promise<Response>;

// A fetch stand-in: records the calls and answers with `handler` (or throws like a transport error).
function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const call = { url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body as string | undefined };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const refused = () => {
  throw new TypeError("fetch failed");
};
const json = (body: unknown, status = 200) => Response.json(body, { status });
const DISCOVERER = "http://discoverer:8080";

function setup(handler: Handler, env: Record<string, string> = {}) {
  const sleeps: number[] = [];
  const f = fakeFetch(handler);
  const client = createClient({
    fetchFn: f.fetchFn,
    sleep: async (ms) => void sleeps.push(ms),
    env: { SERVICE_DISCOVERER_URL: DISCOVERER, SERVICE_HOST: "payments-1:9000", ...env },
  });
  return { ...f, sleeps, client };
}

// Discoverer answering /consult with `hosts` in order; any other URL goes to `target`.
function routed(hosts: string[], target: Handler) {
  const consults: string[] = [];
  const handler: Handler = (call) => {
    if (call.url.startsWith(DISCOVERER + "/consult")) {
      consults.push(call.url);
      return json({ host: hosts.shift() });
    }
    return target(call);
  };
  return { consults, handler };
}

test("Kind has the seven service kinds", () => {
  assert.deepEqual(Object.values(Kind).sort(), [
    "certificates", "events", "notifications", "payments", "reports", "subscription", "user",
  ]);
});

test("register sends kind and SERVICE_HOST", async () => {
  const t = setup(() => new Response(null, { status: 204 }));
  await t.client.register(Kind.PAYMENTS);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].url, `${DISCOVERER}/register`);
  assert.equal(t.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(t.calls[0].body!), { kind: "payments", host: "payments-1:9000" });
});

test("register builds the host from hostname and PORT", async () => {
  const t = setup(() => new Response(null, { status: 204 }), { SERVICE_HOST: "", PORT: "7001" });
  await t.client.register(Kind.USER);
  assert.equal(JSON.parse(t.calls[0].body!).host, `${hostname()}:7001`);
  const d = setup(() => new Response(null, { status: 204 }), { SERVICE_HOST: "" });
  await d.client.register(Kind.USER);
  assert.equal(JSON.parse(d.calls[0].body!).host, `${hostname()}:8080`);
});

test("register retries until success", async () => {
  let n = 0;
  const t = setup(() => new Response(null, { status: ++n <= 3 ? 503 : 204 }));
  await t.client.register(Kind.PAYMENTS);
  assert.equal(t.calls.length, 4);
  assert.deepEqual(t.sleeps, [1000, 2000, 4000]);
});

test("register gives up with backoff", async () => {
  const t = setup(() => new Response("down", { status: 503 }));
  await assert.rejects(
    t.client.register(Kind.PAYMENTS),
    /could not register with the service-discoverer: register failed: 503 down/,
  );
  assert.equal(t.calls.length, 10);
  assert.deepEqual(t.sleeps, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
});

test("register retries transport errors", async () => {
  const t = setup(refused);
  await assert.rejects(t.client.register(Kind.PAYMENTS), /could not register with the service-discoverer: fetch failed/);
  assert.equal(t.sleeps.length, 9);
});

test("consult returns the host and does not cache", async () => {
  const r = routed(["a:1", "b:2"], refused);
  const t = setup(r.handler);
  assert.equal(await t.client.consult(Kind.USER), "a:1");
  assert.equal(await t.client.consult(Kind.USER), "b:2");
  assert.deepEqual(r.consults, [`${DISCOVERER}/consult?kind=user`, `${DISCOVERER}/consult?kind=user`]);
});

test("consult throws on a non-200", async () => {
  const t = setup(() => new Response("no healthy instance\n", { status: 503 }));
  await assert.rejects(t.client.consult(Kind.USER), /^Error: consult user failed: 503 no healthy instance$/);
});

test("request caches the host and sends JSON body and headers", async () => {
  const r = routed(["svc:1"], (c) => json({ echo: JSON.parse(c.body!), x: c.headers["X-Test"], ct: c.headers["Content-Type"] }));
  const t = setup(r.handler);
  for (let i = 0; i < 3; i++) {
    const res = await t.client.request("post", Kind.USER, "/x", { headers: { "X-Test": "1" }, body: { a: 1 } });
    assert.deepEqual(await res.json(), { echo: { a: 1 }, x: "1", ct: "application/json" });
  }
  assert.equal(r.consults.length, 1);
  assert.equal(t.calls.at(-1)!.method, "POST");
  assert.equal(t.calls.at(-1)!.url, "http://svc:1/x");
});

test("request keeps a caller content-type (any case) and sends no body when absent", async () => {
  const r = routed(["svc:1"], () => new Response("ok"));
  const t = setup(r.handler);
  await t.client.request("POST", Kind.USER, "/x", { headers: { "content-type": "text/plain" }, body: "hi" });
  const withBody = t.calls.at(-1)!;
  assert.deepEqual(withBody.headers, { "content-type": "text/plain" });
  assert.equal(withBody.body, '"hi"');
  await t.client.request("GET", Kind.USER, "/x");
  const without = t.calls.at(-1)!;
  assert.equal(without.body, undefined);
  assert.deepEqual(without.headers, {});
});

test("request normalizes the path", async () => {
  const r = routed(["svc:1"], () => new Response("ok"));
  const t = setup(r.handler);
  await t.client.request("GET", Kind.USER, "charge");
  await t.client.request("GET", Kind.USER, "/charge?a=1");
  assert.deepEqual(t.calls.filter((c) => c.url.startsWith("http://svc")).map((c) => c.url), [
    "http://svc:1/charge",
    "http://svc:1/charge?a=1",
  ]);
});

test("request returns HTTP error statuses without throwing or rediscovering", async () => {
  const r = routed(["svc:1"], (c) => new Response("nope", { status: c.url.endsWith("/a") ? 404 : 500 }));
  const t = setup(r.handler);
  const a = await t.client.request("GET", Kind.USER, "/a");
  const b = await t.client.request("GET", Kind.USER, "/b");
  assert.equal(a.status, 404);
  assert.equal(await a.text(), "nope");
  assert.equal(b.status, 500);
  assert.equal(r.consults.length, 1);
});

test("request rediscovers once when the host is unreachable", async () => {
  const r = routed(["dead:1", "good:2"], (c) => (c.url.startsWith("http://dead") ? refused() : json({ ok: true })));
  const t = setup(r.handler);
  const res = await t.client.request("POST", Kind.EVENTS, "/x", { body: { b: 2 } });
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(r.consults.length, 2);
  await t.client.request("POST", Kind.EVENTS, "/x", { body: {} });
  assert.equal(r.consults.length, 2);
});

test("request retries only once", async () => {
  const r = routed(["dead:1", "dead:2", "dead:3"], refused);
  const t = setup(r.handler);
  await assert.rejects(t.client.request("GET", Kind.EVENTS, "/x"), /fetch failed/);
  assert.equal(r.consults.length, 2);
});

test("request rejects when the discoverer has no host", async () => {
  const t = setup(() => new Response("none", { status: 503 }));
  await assert.rejects(t.client.request("GET", Kind.EVENTS, "/x"), /consult events failed: 503 none/);
});

test("concurrent first calls share one consult", async () => {
  const r = routed(["svc:1"], () => new Response("ok"));
  const slow: Handler = async (c) => {
    if (c.url.includes("/consult")) await new Promise((res) => setTimeout(res, 20));
    return r.handler(c);
  };
  const t = setup(slow);
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => t.client.request("GET", Kind.USER, "/x")));
  assert.deepEqual(all.map((x) => x.status), [200, 200, 200, 200, 200]);
  assert.equal(r.consults.length, 1);
});

test("concurrent calls on a stale host share one rediscovery", async () => {
  let alive = true;
  const r = routed(["a:1", "b:2"], (c) => (c.url.startsWith("http://a:1") && !alive ? refused() : new Response("ok")));
  const t = setup(r.handler);
  await t.client.request("GET", Kind.USER, "/x");
  alive = false;
  const all = await Promise.all([1, 2, 3].map(() => t.client.request("GET", Kind.USER, "/x")));
  assert.deepEqual(all.map((x) => x.status), [200, 200, 200]);
  assert.equal(r.consults.length, 2);
});

test("caches are per kind", async () => {
  const r = routed(["u:1", "e:2"], () => new Response("ok"));
  const t = setup(r.handler);
  await t.client.request("GET", Kind.USER, "/x");
  await t.client.request("GET", Kind.EVENTS, "/x");
  await t.client.request("GET", Kind.USER, "/x");
  assert.equal(r.consults.length, 2);
});

// Fake clock (ms) injected as `now`.
function withClock(handler: Handler, extra: { env?: Record<string, string>; ttlSeconds?: number } = {}) {
  const clock = { t: 5000 };
  const f = fakeFetch(handler);
  const client = createClient({
    fetchFn: f.fetchFn,
    sleep: async () => {},
    now: () => clock.t,
    ttlSeconds: extra.ttlSeconds,
    env: { SERVICE_DISCOVERER_URL: DISCOVERER, ...extra.env },
  });
  return { clock, client, ...f };
}

test("host is reused within the TTL and a new consult after it moves to the next host", async () => {
  const r = routed(["a:1", "b:2"], () => new Response("ok"));
  const t = withClock(r.handler);
  await t.client.request("GET", Kind.USER, "/x");
  t.clock.t += 9900;
  await t.client.request("GET", Kind.USER, "/x");
  assert.equal(r.consults.length, 1);
  t.clock.t += 200;
  await t.client.request("GET", Kind.USER, "/x");
  assert.equal(r.consults.length, 2);
  assert.equal(t.calls.at(-1)!.url, "http://b:2/x");
});

test("ttl comes from the env var (decimals) or the ttlSeconds option", async () => {
  const r = routed(["a:1", "b:2", "c:3"], () => new Response("ok"));
  const t = withClock(r.handler, { env: { DISCOVERY_CACHE_TTL_SECONDS: "0.5" } });
  await t.client.request("GET", Kind.USER, "/x");
  t.clock.t += 400;
  await t.client.request("GET", Kind.USER, "/x");
  assert.equal(r.consults.length, 1);
  t.clock.t += 200;
  await t.client.request("GET", Kind.USER, "/x");
  assert.equal(r.consults.length, 2);

  const r2 = routed(["a:1", "b:2"], () => new Response("ok"));
  const o = withClock(r2.handler, { ttlSeconds: 1, env: { DISCOVERY_CACHE_TTL_SECONDS: "100" } });
  await o.client.request("GET", Kind.USER, "/x");
  o.clock.t += 1001;
  await o.client.request("GET", Kind.USER, "/x");
  assert.equal(r2.consults.length, 2);
});

test("ttl 0 consults before every request", async () => {
  for (const opts of [{ ttlSeconds: 0 }, { env: { DISCOVERY_CACHE_TTL_SECONDS: "0" } }]) {
    const r = routed(["a:1", "b:2", "c:3"], () => new Response("ok"));
    const t = withClock(r.handler, opts);
    for (let i = 0; i < 3; i++) await t.client.request("GET", Kind.USER, "/x");
    assert.equal(r.consults.length, 3);
    assert.deepEqual(t.calls.filter((c) => !c.url.includes("/consult")).map((c) => c.url), [
      "http://a:1/x", "http://b:2/x", "http://c:3/x",
    ]);
  }
});

test("an invalid ttl falls back to 10 seconds", async () => {
  for (const bad of ["", "abc", "-1", "NaN", "Infinity", "-Infinity"]) {
    for (const how of ["env", "option"]) {
      const r = routed(["a:1", "b:2"], () => new Response("ok"));
      const t =
        how === "env"
          ? withClock(r.handler, { env: { DISCOVERY_CACHE_TTL_SECONDS: bad } })
          : withClock(r.handler, { ttlSeconds: Number(bad === "" ? "x" : bad) });
      await t.client.request("GET", Kind.USER, "/x");
      t.clock.t += 9900;
      await t.client.request("GET", Kind.USER, "/x");
      assert.equal(r.consults.length, 1, `${how} ${bad}`);
      t.clock.t += 200;
      await t.client.request("GET", Kind.USER, "/x");
      assert.equal(r.consults.length, 2, `${how} ${bad}`);
    }
  }
});

test("an expired host is kept when the refresh fails, and the refresh is retried next call", async () => {
  let discovererUp = true;
  const consults: number[] = [];
  const t = withClock((c) => {
    if (c.url.includes("/consult")) {
      consults.push(1);
      return discovererUp ? json({ host: "a:1" }) : new Response("down", { status: 503 });
    }
    return new Response("ok");
  });
  await t.client.request("GET", Kind.USER, "/x");
  discovererUp = false;
  t.clock.t += 11000;
  const res = await t.client.request("GET", Kind.USER, "/x");
  assert.equal(res.status, 200);
  assert.equal(t.calls.at(-1)!.url, "http://a:1/x");
  assert.equal(consults.length, 2);
  await t.client.request("GET", Kind.USER, "/x");
  assert.equal(consults.length, 3);
});

test("a failed refresh with nothing cached still rejects", async () => {
  const t = withClock(() => new Response("none", { status: 503 }));
  await assert.rejects(t.client.request("GET", Kind.USER, "/x"), /consult user failed: 503 none/);
});

test("rediscovery after a failure resets the TTL", async () => {
  const r = routed(["dead:1", "good:2", "next:3"], (c) => (c.url.startsWith("http://dead") ? refused() : new Response("ok")));
  const t = withClock(r.handler);
  await t.client.request("GET", Kind.USER, "/x"); // dead:1 fails, rediscovers good:2
  assert.equal(r.consults.length, 2);
  t.clock.t += 9900;
  await t.client.request("GET", Kind.USER, "/x");
  assert.equal(r.consults.length, 2);
  t.clock.t += 200;
  await t.client.request("GET", Kind.USER, "/x");
  assert.equal(r.consults.length, 3);
  assert.equal(t.calls.at(-1)!.url, "http://next:3/x");
});

test("a failing rediscovery never falls back to the dead host", async () => {
  let down = false;
  const t = withClock((c) => {
    if (c.url.includes("/consult")) return down ? new Response("down", { status: 503 }) : json({ host: "dead:1" });
    return refused();
  });
  await t.client.request("GET", Kind.USER, "/x").catch(() => {}); // consults dead:1, then dead again
  down = true;
  await assert.rejects(t.client.request("GET", Kind.USER, "/x"), /consult user failed: 503 down/);
});

test("top-level functions are exported", () => {
  assert.equal(typeof register, "function");
  assert.equal(typeof consult, "function");
  assert.equal(typeof request, "function");
});

// ---- Integration: real node:http servers standing in for the discoverer and a service (no Docker).

const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void, port = 0) =>
  new Promise<Server>((resolve) => {
    const s = createServer(handler);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
const portOf = (s: Server) => (s.address() as AddressInfo).port;

async function readBody(req: IncomingMessage) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data;
}

test("integration: register, consult, request and rediscovery after the service moves", async () => {
  const registered: unknown[] = [];
  let current = "";
  const discoverer = await listen(async (req, res) => {
    if (req.method === "POST" && req.url === "/register") {
      registered.push(JSON.parse(await readBody(req)));
      res.writeHead(204).end();
    } else if (req.url === "/consult?kind=payments") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ host: current }));
    } else {
      res.writeHead(400).end("unknown kind");
    }
  });
  const service = (name: string) =>
    listen(async (req, res) => {
      const body = await readBody(req);
      res.writeHead(req.url === "/missing" ? 404 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name, body: body ? JSON.parse(body) : null, x: req.headers["x-test"] }));
    });

  const client = createClient({
    env: { SERVICE_DISCOVERER_URL: `http://127.0.0.1:${portOf(discoverer)}/`, SERVICE_HOST: "me:1234" },
  });
  let first: Server | undefined;
  let second: Server | undefined;
  try {
    await client.register(Kind.USER);
    assert.deepEqual(registered, [{ kind: "user", host: "me:1234" }]);

    first = await service("first");
    current = `127.0.0.1:${portOf(first)}`;
    assert.equal(await client.consult(Kind.PAYMENTS), current);
    const res = await client.request("POST", Kind.PAYMENTS, "charge", { headers: { "X-Test": "1" }, body: { amount: 10 } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: "first", body: { amount: 10 }, x: "1" });
    assert.equal((await client.request("GET", Kind.PAYMENTS, "/missing")).status, 404);

    // The service restarts on another port: the cached host is dead and must be rediscovered.
    await close(first);
    second = await service("second");
    current = `127.0.0.1:${portOf(second)}`;
    const again = await client.request("POST", Kind.PAYMENTS, "/charge", { body: { amount: 11 } });
    assert.deepEqual(await again.json(), { name: "second", body: { amount: 11 } });
  } finally {
    await Promise.all([discoverer, first, second].map((s) => s?.listening ? close(s) : undefined));
  }
});
