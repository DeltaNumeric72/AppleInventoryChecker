import { runCheck } from "../src/checker.ts";
import { ALL_SKUS, STORES } from "../src/catalog.ts";
import { listHistory, listRestocks } from "../src/history.ts";
import { getLastRun, saveSettings } from "../src/settings.ts";
import { getSnapshot } from "../src/stock.ts";
import fixture from "./fixtures/pickup_r121.json" with { type: "json" };
import { assert, assertEquals } from "./_assert.ts";

const NTFY = { server: "https://ntfy.test", topic: "duo" };
const noSleep = () => Promise.resolve();
const ALL_WATCH = STORES.flatMap((s) =>
  ALL_SKUS.map((k) => `${s.id}|${k.part}`)
);

interface Call {
  url: string;
  body?: Record<string, unknown>;
}

const single = (id: string, name: string, available: boolean) =>
  new Response(JSON.stringify({
    body: {
      content: {
        pickupMessage: {
          stores: [{
            storeNumber: id,
            storeName: name,
            partsAvailability: {
              "MK244VC/A": {
                partNumber: "MK244VC/A",
                pickupDisplay: available ? "available" : "unavailable",
                pickupSearchQuote: available ? "Available Today" : "No",
              },
            },
          }],
        },
      },
    },
  }));

/**
 * Mock Apple + ntfy. The fixture covers 8 stores; R464 and R489 need
 * follow-up requests. `state` controls those and the main fixture.
 */
function makeMock() {
  const state = {
    r464: false,
    r489: false,
    broken: false,
    failR464: false,
    anchorAvailable: true,
  };
  const calls: Call[] = [];
  const requested: string[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    if (url.startsWith(NTFY.server)) {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return Promise.resolve(new Response("{}"));
    }
    calls.push({ url });
    if (state.broken) return Promise.resolve(new Response("<html/>"));
    const store = new URL(url).searchParams.get("store")!;
    requested.push(store);
    if (store === "R464") {
      return Promise.resolve(
        state.failR464
          ? new Response("", { status: 500 })
          : single("R464", "Conestoga", state.r464),
      );
    }
    if (store === "R489") {
      return Promise.resolve(single("R489", "Masonville", state.r489));
    }
    const body = structuredClone(fixture);
    if (!state.anchorAvailable) {
      const eaton = body.body.content.pickupMessage.stores[0];
      // deno-lint-ignore no-explicit-any
      (eaton.partsAvailability as any)["MK264VC/A"].pickupDisplay =
        "unavailable";
    }
    return Promise.resolve(new Response(JSON.stringify(body)));
  };
  return {
    state,
    fetchFn,
    requested,
    ntfyCalls: () => calls.filter((c) => c.body),
  };
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

const T0 = new Date("2026-05-01T12:00:00Z");
const at = (min: number) => () => new Date(T0.getTime() + min * 60_000);

Deno.test("runCheck: disabled still fetches all stores, but no push and no history", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: false, watch: ALL_WATCH });
    const m = makeMock();
    m.state.r464 = true;
    const r = await runCheck(kv, {
      fetchFn: m.fetchFn,
      sleep: noSleep,
      ntfy: NTFY,
      now: at(0),
    });
    assertEquals(m.requested, ["R121", "R464", "R489"]);
    assert(r.ok);
    assertEquals(r.hits, []);
    assertEquals(r.notified, false);
    assertEquals(r.storesChecked.length, 10);
    assertEquals(m.ntfyCalls().length, 0);
    assertEquals(await listHistory(kv, { now: T0 }), []);
    const snap = await getSnapshot(kv);
    assertEquals(Object.keys(snap!.stores).length, 10);
    assertEquals(snap!.stores["R464"].parts["MK244VC/A"].available, true);
    assertEquals((await getLastRun(kv))?.ok, true);
  });
});

Deno.test("runCheck: watched hits push every run, one in_stock entry, then sold_out", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, {
      enabled: true,
      watch: ["R121|MK264VC/A", "R350|MK2C4VC/A", "R464|MK244VC/A"],
    });
    const m = makeMock();
    m.state.r464 = true;
    const run = (min: number) =>
      runCheck(kv, {
        fetchFn: m.fetchFn,
        sleep: noSleep,
        ntfy: NTFY,
        now: at(min),
      });

    const r1 = await run(0);
    assert(r1.ok && r1.notified);
    assertEquals(r1.at, "2026-05-01T12:00:00.000Z");
    assertEquals(
      r1.hits.map((h) => `${h.storeId}:${h.part}`),
      ["R121:MK264VC/A", "R350:MK2C4VC/A", "R464:MK244VC/A"],
    );
    const r2 = await run(1);
    assert(r2.notified);
    assertEquals(m.ntfyCalls().length, 2);

    const msg = m.ntfyCalls()[0].body!;
    assertEquals(msg.priority, 5);
    assertEquals(msg.title, "iPhone Duo in stock at 3 GTA stores");
    assertEquals(
      msg.click,
      "https://www.apple.com/ca/shop/buy-iphone/iphone-duo",
    );

    let hist = await listHistory(kv, { now: at(2)() });
    assertEquals(hist.length, 3);
    assert(hist.every((h) => h.kind === "in_stock" && h.at === r1.at));

    // R464 sells out, Eaton too.
    m.state.r464 = false;
    m.state.anchorAvailable = false;
    const r3 = await run(2);
    assertEquals(r3.hits.map((h) => h.storeId), ["R350"]);
    hist = await listHistory(kv, { now: at(3)() });
    assertEquals(hist.length, 5);
    assertEquals(
      hist.slice(0, 2).map((h) => `${h.kind}:${h.storeId}:${h.part}`).sort(),
      ["sold_out:R121:MK264VC/A", "sold_out:R464:MK244VC/A"],
    );
    assertEquals((await getLastRun(kv))?.hits.length, 1);
  });
});

Deno.test("runCheck: restock events appended on transitions only", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: false, watch: [] });
    const m = makeMock();
    const run = (min: number) =>
      runCheck(kv, {
        fetchFn: m.fetchFn,
        sleep: noSleep,
        ntfy: null,
        now: at(min),
      });
    const events = () => listRestocks(kv, { now: at(10)() });

    await run(0); // first run: no previous snapshot, nothing logged
    assertEquals(await events(), []);
    await run(1); // unchanged
    assertEquals(await events(), []);

    m.state.r464 = true;
    m.state.r489 = true;
    await run(2);
    let ev = await events();
    assertEquals(
      ev.map((e) => `${e.storeId}:${e.part}`).sort(),
      ["R464:MK244VC/A", "R489:MK244VC/A"],
    );
    assert(ev.every((e) => e.at === "2026-05-01T12:02:00.000Z"));

    await run(3); // still available: no new events
    assertEquals((await events()).length, 2);

    m.state.r464 = false; // sold out: no event
    await run(4);
    assertEquals((await events()).length, 2);

    m.state.r464 = true; // restock again
    await run(5);
    ev = await events();
    assertEquals(ev.length, 3);
    assertEquals(ev[2].at, "2026-05-01T12:05:00.000Z");
  });
});

Deno.test("runCheck: missing store keeps old snapshot data and logs no sold_out", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R464|MK244VC/A"] });
    const m = makeMock();
    m.state.r464 = true;
    const deps = (min: number) => ({
      fetchFn: m.fetchFn,
      sleep: noSleep,
      ntfy: null,
      now: at(min),
    });
    await runCheck(kv, deps(0));
    m.state.failR464 = true;
    const r = await runCheck(kv, deps(1));
    assert(r.ok);
    assertEquals(r.storesMissing, ["R464"]);
    // The hit is carried forward (not re-notified) while R464 is unchecked.
    assertEquals(r.hits.map((h) => h.storeId), ["R464"]);
    const snap = (await getSnapshot(kv))!;
    assertEquals(snap.at, "2026-05-01T12:01:00.000Z");
    assertEquals(snap.stores["R464"].checkedAt, "2026-05-01T12:00:00.000Z");
    assertEquals(snap.stores["R464"].parts["MK244VC/A"].available, true);
    assertEquals(snap.stores["R121"].checkedAt, "2026-05-01T12:01:00.000Z");
    const hist = await listHistory(kv, { now: at(2)() });
    assertEquals(hist.map((h) => h.kind), ["in_stock"]);
    // R464 is back and still in stock: no duplicate in_stock entry.
    m.state.failR464 = false;
    await runCheck(kv, deps(2));
    const hist2 = await listHistory(kv, { now: at(3)() });
    assertEquals(hist2.map((h) => h.kind), ["in_stock"]);
  });
});

Deno.test("runCheck: a failed run doesn't cause a duplicate in_stock entry", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R121|MK264VC/A"] });
    const m = makeMock();
    const deps = (min: number) => ({
      fetchFn: m.fetchFn,
      sleep: noSleep,
      ntfy: null,
      now: at(min),
    });
    await runCheck(kv, deps(0));
    m.state.broken = true;
    assert(!(await runCheck(kv, deps(1))).ok);
    m.state.broken = false;
    await runCheck(kv, deps(2));
    const hist = await listHistory(kv, { now: at(3)() });
    assertEquals(hist.map((h) => h.kind), ["in_stock"]);
  });
});

Deno.test("runCheck: unwatching an in-stock pair is not logged as sold_out", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R121|MK264VC/A"] });
    const m = makeMock();
    const deps = (min: number) => ({
      fetchFn: m.fetchFn,
      sleep: noSleep,
      ntfy: null,
      now: at(min),
    });
    await runCheck(kv, deps(0));
    await saveSettings(kv, { enabled: true, watch: [] });
    await runCheck(kv, deps(1));
    const hist = await listHistory(kv, { now: at(2)() });
    assertEquals(hist.map((h) => h.kind), ["in_stock"]);
  });
});

Deno.test("runCheck: no hits means no ntfy", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R121|MK244VC/A"] });
    const m = makeMock();
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

Deno.test("runCheck: failure warning sent exactly once at 10 and logged, success resets", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R121|MK264VC/A"] });
    const m = makeMock();
    m.state.broken = true;
    const run = (min = 0) =>
      runCheck(kv, {
        fetchFn: m.fetchFn,
        sleep: noSleep,
        ntfy: NTFY,
        now: at(min),
      });

    for (let i = 1; i <= 9; i++) {
      const r = await run(i);
      assert(!r.ok);
      assertEquals(r.consecutiveFailures, i);
    }
    assertEquals(m.ntfyCalls().length, 0);
    assertEquals(await listHistory(kv, { now: at(10)() }), []);

    const tenth = await run(10);
    assertEquals(tenth.consecutiveFailures, 10);
    assertEquals(m.ntfyCalls().length, 1);
    const warn = m.ntfyCalls()[0].body!;
    assertEquals(warn.priority, 3);
    assert(String(warn.title).startsWith("Stock checker failing: "));
    const hist = await listHistory(kv, { now: at(11)() });
    assertEquals(hist.length, 1);
    assertEquals(hist[0].kind, "warning");
    assertEquals(hist[0].message, warn.title);

    await run(11);
    await run(12);
    assertEquals(m.ntfyCalls().length, 1);
    assertEquals((await listHistory(kv, { now: at(13)() })).length, 1);

    m.state.broken = false;
    const good = await run(13);
    assert(good.ok);
    assertEquals(good.consecutiveFailures, 0);
    assertEquals((await getLastRun(kv))?.consecutiveFailures, 0);
  });
});

Deno.test("runCheck: failure warning is logged even without ntfy", async () => {
  await withKv(async (kv) => {
    const m = makeMock();
    m.state.broken = true;
    for (let i = 1; i <= 10; i++) {
      await runCheck(kv, {
        fetchFn: m.fetchFn,
        sleep: noSleep,
        ntfy: null,
        now: at(i),
      });
    }
    const hist = await listHistory(kv, { now: at(11)() });
    assertEquals(hist.map((h) => h.kind), ["warning"]);
  });
});

Deno.test("runCheck: never throws, even if ntfy fails", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R121|MK264VC/A"] });
    const m = makeMock();
    const fetchFn: typeof fetch = (input, init) =>
      String(input).startsWith(NTFY.server)
        ? Promise.resolve(new Response("no", { status: 500 }))
        : m.fetchFn(input, init);
    const r = await runCheck(kv, { fetchFn, sleep: noSleep, ntfy: NTFY });
    assert(r.ok);
    assertEquals(r.hits.length, 1);
    assertEquals(r.notified, false);
  });
});
