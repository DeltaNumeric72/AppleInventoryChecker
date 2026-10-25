import { runCheck } from "../src/checker.ts";
import { getLastRun, saveSettings } from "../src/settings.ts";
import fixture from "./fixtures/pickup_r121.json" with { type: "json" };
import { assert, assertEquals } from "./_assert.ts";

const NTFY = { server: "https://ntfy.test", topic: "duo" };
const noSleep = () => Promise.resolve();

interface Call {
  url: string;
  body?: Record<string, unknown>;
}

/** Mock that records calls; Apple calls get `apple()`, ntfy calls get 200. */
function makeFetch(apple: () => Response) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    if (url.startsWith(NTFY.server)) {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return Promise.resolve(new Response("{}"));
    }
    calls.push({ url });
    return Promise.resolve(apple());
  };
  return { fetchFn, calls, ntfyCalls: () => calls.filter((c) => c.body) };
}

const okApple = () => new Response(JSON.stringify(fixture), { status: 200 });
const badApple = () => new Response("<html>blocked</html>", { status: 200 });

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("runCheck: disabled makes no network calls", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, {
      enabled: false,
      skus: ["MK244VC/A"],
      stores: ["R121"],
    });
    const m = makeFetch(okApple);
    const r = await runCheck(kv, {
      fetchFn: m.fetchFn,
      sleep: noSleep,
      ntfy: NTFY,
    });
    assertEquals(m.calls.length, 0);
    assert(r.ok);
    assertEquals(r.hits, []);
    assertEquals((await getLastRun(kv))?.ok, true);
  });
});

Deno.test("runCheck: empty selection makes no network calls", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, skus: [], stores: ["R121"] });
    const m = makeFetch(okApple);
    await runCheck(kv, { fetchFn: m.fetchFn, sleep: noSleep, ntfy: NTFY });
    await saveSettings(kv, { enabled: true, skus: ["MK244VC/A"], stores: [] });
    await runCheck(kv, { fetchFn: m.fetchFn, sleep: noSleep, ntfy: NTFY });
    assertEquals(m.calls.length, 0);
  });
});

Deno.test("runCheck: hits send one ntfy every run", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, {
      enabled: true,
      skus: ["MK264VC/A", "MK2C4VC/A"],
      stores: ["R121", "R350"],
    });
    const m = makeFetch(okApple);
    const now = () => new Date("2026-05-01T12:00:00Z");
    for (let i = 1; i <= 2; i++) {
      const r = await runCheck(kv, {
        fetchFn: m.fetchFn,
        sleep: noSleep,
        ntfy: NTFY,
        now,
      });
      assert(r.ok && r.notified);
      assertEquals(r.at, "2026-05-01T12:00:00.000Z");
      assertEquals(r.hits.length, 2);
      assertEquals(m.ntfyCalls().length, i);
    }
    const msg = m.ntfyCalls()[0].body!;
    assertEquals(msg.priority, 5);
    assertEquals(msg.title, "iPhone Duo in stock at 2 GTA stores");
    assertEquals(
      msg.click,
      "https://www.apple.com/ca/shop/buy-iphone/iphone-duo",
    );
    assertEquals((await getLastRun(kv))?.notified, true);
  });
});

Deno.test("runCheck: no hits means no ntfy", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, {
      enabled: true,
      skus: ["MK244VC/A"],
      stores: ["R121"],
    });
    const m = makeFetch(okApple);
    const r = await runCheck(kv, {
      fetchFn: m.fetchFn,
      sleep: noSleep,
      ntfy: NTFY,
    });
    assertEquals(r.hits, []);
    assertEquals(r.notified, false);
    assertEquals(m.ntfyCalls().length, 0);
  });
});

Deno.test("runCheck: failure warning sent exactly once at 10, success resets", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, {
      enabled: true,
      skus: ["MK264VC/A"],
      stores: ["R121"],
    });
    let healthy = false;
    const m = makeFetch(() => healthy ? okApple() : badApple());
    const run = () =>
      runCheck(kv, { fetchFn: m.fetchFn, sleep: noSleep, ntfy: NTFY });

    for (let i = 1; i <= 9; i++) {
      const r = await run();
      assert(!r.ok);
      assertEquals(r.consecutiveFailures, i);
    }
    assertEquals(m.ntfyCalls().length, 0);

    const tenth = await run();
    assertEquals(tenth.consecutiveFailures, 10);
    assertEquals(m.ntfyCalls().length, 1);
    const warn = m.ntfyCalls()[0].body!;
    assertEquals(warn.priority, 3);
    assert(String(warn.title).startsWith("Stock checker failing: "));

    await run();
    await run();
    assertEquals(m.ntfyCalls().length, 1);

    healthy = true;
    const good = await run();
    assert(good.ok);
    assertEquals(good.consecutiveFailures, 0);
    assertEquals((await getLastRun(kv))?.consecutiveFailures, 0);
  });
});

Deno.test("runCheck: never throws, even if ntfy fails", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, {
      enabled: true,
      skus: ["MK264VC/A"],
      stores: ["R121"],
    });
    const fetchFn: typeof fetch = (input) =>
      Promise.resolve(
        String(input).startsWith(NTFY.server)
          ? new Response("no", { status: 500 })
          : okApple(),
      );
    const r = await runCheck(kv, { fetchFn, sleep: noSleep, ntfy: NTFY });
    assert(r.ok);
    assertEquals(r.hits.length, 1);
    assertEquals(r.notified, false);
  });
});
