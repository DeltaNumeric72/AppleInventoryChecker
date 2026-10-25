import { createHandler } from "../src/web.ts";
import { getSettings, type RunStatus, saveLastRun } from "../src/settings.ts";
import { assert, assertEquals } from "./_assert.ts";

const PW = "s3cret";
const auth = { Authorization: "Basic " + btoa("me:" + PW) };
const ntfy = { server: "https://ntfy.example", topic: "my-topic" };
const goodRun: RunStatus = {
  at: "2026-01-01T15:00:00Z",
  ok: true,
  hits: [],
  storesChecked: [],
  storesMissing: [],
  notified: false,
  consecutiveFailures: 0,
};

function post(
  path: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...auth,
      ...headers,
    },
    body,
  });
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("auth: 401 without credentials, 401 with wrong password", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, { adminPassword: PW, ntfy });
    const r = await h(new Request("http://localhost/"));
    assertEquals(r.status, 401);
    assert(r.headers.get("WWW-Authenticate")?.startsWith("Basic"));
    const bad = await h(
      new Request("http://localhost/", {
        headers: { Authorization: "Basic " + btoa("x:wrong") },
      }),
    );
    assertEquals(bad.status, 401);
    const ok = await h(new Request("http://localhost/", { headers: auth }));
    assertEquals(ok.status, 200);
    assertEquals(ok.headers.get("Cache-Control"), "no-store");
  });
});

Deno.test("503 when no password configured; /health stays public", async () => {
  await withKv(async (kv) => {
    const prev = Deno.env.get("ADMIN_PASSWORD");
    Deno.env.delete("ADMIN_PASSWORD");
    try {
      const h = createHandler(kv, { ntfy: null });
      assertEquals((await h(new Request("http://localhost/"))).status, 503);
      const health = await h(new Request("http://localhost/health"));
      assertEquals(health.status, 200);
      assertEquals(await health.text(), "ok");
    } finally {
      if (prev !== undefined) Deno.env.set("ADMIN_PASSWORD", prev);
    }
  });
});

Deno.test("404 and 405", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, { adminPassword: PW, ntfy });
    assertEquals(
      (await h(new Request("http://localhost/nope", { headers: auth }))).status,
      404,
    );
    assertEquals(
      (await h(new Request("http://localhost/settings", { headers: auth })))
        .status,
      405,
    );
    assertEquals((await h(post("/", ""))).status, 405);
  });
});

Deno.test("POST /settings round-trips and drops unknown values", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, { adminPassword: PW, ntfy });
    const r = await h(
      post(
        "/settings",
        "sku=MK244VC%2FA&sku=BOGUS&store=R121&store=R999",
        { Origin: "http://localhost" },
      ),
    );
    assertEquals(r.status, 303);
    assertEquals(r.headers.get("Location"), "/?saved=1");
    assertEquals(await getSettings(kv), {
      enabled: false,
      skus: ["MK244VC/A"],
      stores: ["R121"],
    });
    const r2 = await h(post("/settings", "enabled=on&sku=MK254VC%2FA"));
    assertEquals(r2.status, 303);
    const s = await getSettings(kv);
    assertEquals(s.enabled, true);
    assertEquals(s.skus, ["MK254VC/A"]);
    assertEquals(s.stores, []);
    const api = await h(
      new Request("http://localhost/api/status", { headers: auth }),
    );
    assertEquals((await api.json()).settings, s);
  });
});

Deno.test("CSRF: mismatched Origin/Referer rejected", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, { adminPassword: PW, ntfy });
    const r = await h(
      post("/settings", "sku=MK244VC%2FA", { Origin: "https://evil.example" }),
    );
    assertEquals(r.status, 403);
    const r2 = await h(
      post("/run", "", { Referer: "https://evil.example/x" }),
    );
    assertEquals(r2.status, 403);
    assertEquals((await getSettings(kv)).skus.length, 8);
  });
});

Deno.test("POST /test-notify uses injected ntfy and fetchFn", async () => {
  await withKv(async (kv) => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const h = createHandler(kv, { adminPassword: PW, ntfy, fetchFn });
    const r = await h(post("/test-notify", ""));
    assertEquals(r.headers.get("Location"), "/?tested=1");
    assertEquals(calls.length, 1);
    assert(calls[0].url.startsWith("https://ntfy.example"));
    assertEquals(JSON.parse(calls[0].body).topic, "my-topic");

    const failing = createHandler(kv, {
      adminPassword: PW,
      ntfy,
      fetchFn: (() =>
        Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch,
    });
    const r2 = await failing(post("/test-notify", ""));
    assert(r2.headers.get("Location")!.startsWith("/?error="));

    const none = createHandler(kv, { adminPassword: PW, ntfy: null });
    const r3 = await none(post("/test-notify", ""));
    assert(r3.headers.get("Location")!.startsWith("/?error="));
  });
});

Deno.test("POST /run calls injected runCheck", async () => {
  await withKv(async (kv) => {
    let n = 0;
    const h = createHandler(kv, {
      adminPassword: PW,
      ntfy,
      runCheck: () => {
        n++;
        return Promise.resolve(goodRun);
      },
    });
    const r = await h(post("/run", ""));
    assertEquals(r.headers.get("Location"), "/?ran=1");
    assertEquals(n, 1);
  });
});

Deno.test("GET / renders SKUs, stores, and escapes lastRun error", async () => {
  await withKv(async (kv) => {
    await saveLastRun(kv, {
      ...goodRun,
      ok: false,
      error: "<script>alert(1)</script>",
      hits: [{
        storeId: "R121",
        storeName: "Eaton <b>Centre</b>",
        part: "MK244VC/A",
        quote: "Today",
      }],
      consecutiveFailures: 3,
    });
    const h = createHandler(kv, { adminPassword: PW, ntfy });
    const r = await h(
      new Request("http://localhost/?error=%3Cimg%20src%3Dx%3E", {
        headers: auth,
      }),
    );
    const html = await r.text();
    assert(html.includes("<title>iPhone Duo Stock Watcher</title>"));
    assert(html.includes("iPhone Duo 256GB Star White"));
    assert(html.includes("iPhone Duo 2TB Night Sky"));
    assert(html.includes("Eaton Centre"));
    assert(html.includes("my-topic"));
    assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert(!html.includes("<script>alert(1)"));
    assert(html.includes("Eaton &lt;b&gt;Centre&lt;/b&gt;"));
    assert(html.includes("&lt;img src=x&gt;"));
    assert(!html.includes("<img src=x>"));
    assert(html.includes("every minute"));
  });
});

Deno.test("GET / warns when ntfy is not configured", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, { adminPassword: PW, ntfy: null });
    const html =
      await (await h(new Request("http://localhost/", { headers: auth })))
        .text();
    assert(html.includes("ntfy is not configured"));
    assert(html.includes("No check has run yet"));
  });
});
