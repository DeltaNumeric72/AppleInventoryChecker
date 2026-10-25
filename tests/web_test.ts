import { createHandler } from "../src/web.ts";
import {
  getSettings,
  pairKey,
  type RunStatus,
  saveLastRun,
} from "../src/settings.ts";
import { saveSnapshot } from "../src/stock.ts";
import { appendHistory, appendRestocks } from "../src/history.ts";
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

Deno.test("POST /toggle flips a pair and redirects to the stock anchor", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, { adminPassword: PW, ntfy });
    const key = pairKey("R121", "MK244VC/A");
    assert((await getSettings(kv)).watch.includes(key));
    const r = await h(post("/toggle", "store=R121&part=MK244VC%2FA"));
    assertEquals(r.status, 303);
    assertEquals(r.headers.get("Location"), "/?tab=stock#R121");
    assert(!(await getSettings(kv)).watch.includes(key));
    await h(post("/toggle", "store=R121&part=MK244VC%2FA"));
    assert((await getSettings(kv)).watch.includes(key));
    const before = (await getSettings(kv)).watch.length;
    await h(post("/toggle", "store=BOGUS&part=MK244VC%2FA"));
    assertEquals((await getSettings(kv)).watch.length, before);
  });
});

Deno.test("POST /settings: bulk replace/add/remove and enabled", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, { adminPassword: PW, ntfy });
    const r = await h(
      post(
        "/settings",
        "mode=replace&color=nightsky&size=256GB&size=512GB&store=R121&store=R999&size=BOGUS",
        { Origin: "http://localhost" },
      ),
    );
    assertEquals(r.status, 303);
    assertEquals(r.headers.get("Location"), "/?tab=settings&saved=1");
    let s = await getSettings(kv);
    assertEquals(s.enabled, true);
    assertEquals(s.watch, [
      pairKey("R121", "MK254VC/A"),
      pairKey("R121", "MK274VC/A"),
    ]);
    await h(post("/settings", "mode=add&color=starwhite&size=1TB&store=R120"));
    s = await getSettings(kv);
    assertEquals(s.watch, [
      pairKey("R121", "MK254VC/A"),
      pairKey("R121", "MK274VC/A"),
      pairKey("R120", "MK284VC/A"),
    ]);
    await h(
      post("/settings", "mode=remove&color=nightsky&size=256GB&store=R121"),
    );
    assertEquals((await getSettings(kv)).watch, [
      pairKey("R121", "MK274VC/A"),
      pairKey("R120", "MK284VC/A"),
    ]);
    // Bulk posts leave `enabled` alone; the alerts form sets it.
    await h(post("/settings", "alerts_form=1"));
    s = await getSettings(kv);
    assertEquals(s.enabled, false);
    assertEquals(s.watch.length, 2);
    await h(post("/settings", "mode=add&color=nightsky&size=2TB&store=R121"));
    assertEquals((await getSettings(kv)).enabled, false);
    await h(post("/settings", "alerts_form=1&enabled=on"));
    s = await getSettings(kv);
    assertEquals(s.enabled, true);
    const api = await h(
      new Request("http://localhost/api/status", { headers: auth }),
    );
    const body = await api.json();
    assertEquals(body.settings, s);
    assertEquals(body.snapshot, null);
  });
});

Deno.test("CSRF: mismatched Origin/Referer rejected", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, { adminPassword: PW, ntfy });
    const r = await h(
      post("/settings", "mode=replace", { Origin: "https://evil.example" }),
    );
    assertEquals(r.status, 403);
    const r2 = await h(
      post("/run", "", { Referer: "https://evil.example/x" }),
    );
    assertEquals(r2.status, 403);
    assertEquals((await getSettings(kv)).watch.length, 80);
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
    assertEquals(r.headers.get("Location"), "/?tab=stock&tested=1");
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
    assert(r2.headers.get("Location")!.startsWith("/?tab=stock&error="));

    const none = createHandler(kv, { adminPassword: PW, ntfy: null });
    const r3 = await none(post("/test-notify", ""));
    assert(r3.headers.get("Location")!.startsWith("/?tab=stock&error="));
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
    assertEquals(r.headers.get("Location"), "/?tab=stock&ran=1");
    assertEquals(n, 1);
  });
});

async function get(h: (r: Request) => Promise<Response>, path: string) {
  return await (await h(
    new Request("http://localhost" + path, { headers: auth }),
  ))
    .text();
}

const NOW = new Date("2026-01-10T17:00:00Z");
const ago = (min: number) =>
  new Date(NOW.getTime() - min * 60000).toISOString();

async function seed(kv: Deno.Kv) {
  await saveSnapshot(kv, {
    at: ago(0),
    stores: {
      R121: {
        checkedAt: ago(0),
        parts: {
          "MK244VC/A": { available: true, quote: "Today" },
          "MK254VC/A": { available: true, quote: "Today" },
          "MK264VC/A": { available: false },
        },
      },
    },
  });
  await appendHistory(kv, [
    { at: ago(90), kind: "in_stock", storeId: "R121", part: "MK244VC/A" },
    { at: ago(80), kind: "sold_out", storeId: "R121", part: "MK244VC/A" },
    { at: ago(70), kind: "warning", message: "Checks failing <b>10</b>" },
  ]);
  await appendRestocks(kv, [
    { at: "2026-01-09T14:00:00Z", storeId: "R121", part: "MK244VC/A" }, // 9am
    { at: "2026-01-09T14:00:00Z", storeId: "R121", part: "MK254VC/A" },
    { at: "2026-01-08T14:00:00Z", storeId: "R120", part: "MK244VC/A" },
    { at: "2026-01-08T14:00:00Z", storeId: "R120", part: "MK2C4VC/A" },
  ]);
}

Deno.test("tab: stock shows check marks and option counts", async () => {
  await withKv(async (kv) => {
    await seed(kv);
    const h = createHandler(kv, { adminPassword: PW, ntfy, now: () => NOW });
    const html = await get(h, "/");
    assert(html.includes("✓"));
    assert(html.includes("2 options available"));
    assert(
      html.includes(
        "2</strong> colour/size options available across 10 stores",
      ),
    );
    assert(html.includes('id="R121"'));
    assert(html.includes("Last restock"));
    assert(html.includes('http-equiv="refresh"'));
    assert(html.includes("Eaton Centre"));
    assert(html.includes("google.com/maps"));
    const u = await get(h, "/?tab=nonsense");
    assert(u.includes("options available across 10 stores"));
  });
});

Deno.test("tab: stock with nothing in stock", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, { adminPassword: PW, ntfy });
    const html = await get(h, "/?tab=stock");
    assert(html.includes("No check has run yet"));
    assert(html.includes("None available"));
    assert(!html.includes("✓"));
  });
});

Deno.test("tab: changes lists history with badges", async () => {
  await withKv(async (kv) => {
    await seed(kv);
    const h = createHandler(kv, { adminPassword: PW, ntfy, now: () => NOW });
    const html = await get(h, "/?tab=changes");
    assert(html.includes("Notification history"));
    assert(html.includes("IN STOCK"));
    assert(html.includes("SOLD OUT"));
    assert(html.includes("WARNING"));
    assert(html.includes("Star White 256GB at Eaton Centre"));
    assert(html.includes("Checks failing &lt;b&gt;10&lt;/b&gt;"));
    assert(!html.includes("http-equiv"));
  });
});

Deno.test("tab: patterns counts and filters", async () => {
  await withKv(async (kv) => {
    await seed(kv);
    const h = createHandler(kv, { adminPassword: PW, ntfy, now: () => NOW });
    const all = await get(h, "/?tab=patterns");
    assert(all.includes("When does stock come in?"));
    assert(all.includes("Based on 4 restocks"));
    assert(all.includes("around <b>9am–10am</b>"));
    assert(all.includes("<b>Thursday</b>"));
    const store = await get(h, "/?tab=patterns&store=R120");
    assert(store.includes("Based on 2 restocks"));
    assert(store.includes('<option value="R120" selected>'));
    const color = await get(h, "/?tab=patterns&color=nightsky");
    assert(color.includes("Based on 2 restocks"));
    const size = await get(
      h,
      "/?tab=patterns&size=2TB&color=nightsky&store=R120",
    );
    assert(size.includes("Based on 1 restock."));
    const none = await get(h, "/?tab=patterns&size=1TB");
    assert(none.includes("No restocks logged yet"));
  });
});

Deno.test("tab: settings renders status and redirects return to tab", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, {
      adminPassword: PW,
      ntfy,
      runCheck: () => Promise.resolve(goodRun),
    });
    const html = await get(h, "/?tab=settings");
    assert(html.includes("Bulk watch tool"));
    assert(html.includes("my-topic"));
    const r = await h(post("/run", "return=settings"));
    assertEquals(r.headers.get("Location"), "/?tab=settings&ran=1");
  });
});

Deno.test("escaping: malicious lastRun error and query values", async () => {
  await withKv(async (kv) => {
    await saveLastRun(kv, {
      ...goodRun,
      ok: false,
      error: "<script>alert(1)</script>",
      hits: [{
        storeId: "R121",
        storeName: "Eaton <b>Centre</b>",
        part: "MK244VC/A",
      }],
      consecutiveFailures: 3,
    });
    const h = createHandler(kv, { adminPassword: PW, ntfy: null });
    for (const tab of ["stock", "changes", "patterns", "settings"]) {
      const html = await get(h, `/?tab=${tab}&error=%3Cimg%20src%3Dx%3E`);
      assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
      assert(!html.includes("<script>alert(1)"));
      assert(html.includes("&lt;img src=x&gt;"));
      assert(!html.includes("<img src=x>"));
      assert(html.includes("ntfy is not configured"));
    }
    const s = await get(h, "/?tab=settings");
    assert(
      s.includes("Eaton &lt;b&gt;Centre&lt;/b&gt;") || !s.includes("<b>Centre"),
    );
  });
});
