import { ALL_SKUS, STORES } from "../src/catalog.ts";
import {
  DEFAULT_SETTINGS,
  getLastRun,
  getSettings,
  pairKey,
  parsePairKey,
  type RunStatus,
  sanitizeSettings,
  saveLastRun,
  saveSettings,
  toggleWatch,
} from "../src/settings.ts";
import { assert, assertEquals } from "./_assert.ts";

Deno.test("pairKey / parsePairKey round trip and rejects junk", () => {
  assertEquals(pairKey("R121", "MK244VC/A"), "R121|MK244VC/A");
  assertEquals(parsePairKey("R121|MK244VC/A"), {
    storeId: "R121",
    part: "MK244VC/A",
  });
  assertEquals(parsePairKey("nope"), null);
  assertEquals(parsePairKey("|X"), null);
  assertEquals(parsePairKey("R121|"), null);
});

Deno.test("sanitizeSettings: drops unknown pairs, dedupes, orders", () => {
  const s = sanitizeSettings({
    enabled: false,
    watch: [
      "R464|MK244VC/A",
      "R121|MK254VC/A",
      "R121|MK254VC/A",
      "R121|BOGUS",
      "R999|MK244VC/A",
      42,
      null,
      "R121|MK244VC/A",
    ],
  });
  assertEquals(s, {
    enabled: false,
    watch: ["R121|MK244VC/A", "R121|MK254VC/A", "R464|MK244VC/A"],
  });
});

Deno.test("sanitizeSettings: bad input yields defaults / empty watch", () => {
  assertEquals(sanitizeSettings(null), DEFAULT_SETTINGS);
  assertEquals(sanitizeSettings("x"), DEFAULT_SETTINGS);
  assertEquals(sanitizeSettings({}), { enabled: true, watch: [] });
  assertEquals(sanitizeSettings({ enabled: "yes", watch: "R121|MK244VC/A" }), {
    enabled: false,
    watch: [],
  });
});

Deno.test("sanitizeSettings: legacy {skus, stores} becomes their product", () => {
  const s = sanitizeSettings({
    enabled: true,
    skus: ["MK254VC/A", "BOGUS", "MK244VC/A"],
    stores: ["R464", "R999", "R121"],
  });
  assertEquals(s, {
    enabled: true,
    watch: [
      "R121|MK244VC/A",
      "R121|MK254VC/A",
      "R464|MK244VC/A",
      "R464|MK254VC/A",
    ],
  });
  // Legacy settings predate Masonville, which therefore starts unwatched.
  const full = sanitizeSettings({
    skus: ALL_SKUS.map((x) => x.part),
    stores: STORES.slice(0, 9).map((x) => x.id),
  });
  assertEquals(full.watch.length, 9 * ALL_SKUS.length);
  assert(!full.watch.some((k) => k.startsWith("R489|")));
  // An explicit watch list wins over legacy fields.
  assertEquals(
    sanitizeSettings({ watch: ["R121|MK244VC/A"], skus: ["MK254VC/A"] }).watch,
    ["R121|MK244VC/A"],
  );
});

Deno.test("DEFAULT_SETTINGS watches every store x SKU", () => {
  assertEquals(DEFAULT_SETTINGS.enabled, true);
  assertEquals(DEFAULT_SETTINGS.watch.length, ALL_SKUS.length * STORES.length);
  assertEquals(STORES.length, 10);
});

Deno.test("KV round trip for settings and last run", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    assertEquals(await getSettings(kv), DEFAULT_SETTINGS);
    assertEquals(await getLastRun(kv), null);

    await saveSettings(kv, {
      enabled: false,
      watch: ["R121|MK244VC/A", "R121|NOPE"],
    });
    assertEquals(await getSettings(kv), {
      enabled: false,
      watch: ["R121|MK244VC/A"],
    });

    const run: RunStatus = {
      at: "2026-01-01T00:00:00.000Z",
      ok: true,
      hits: [{ storeId: "R121", storeName: "Eaton Centre", part: "MK244VC/A" }],
      storesChecked: ["R121"],
      storesMissing: [],
      notified: true,
      consecutiveFailures: 0,
    };
    await saveLastRun(kv, run);
    assertEquals(await getLastRun(kv), run);
  } finally {
    kv.close();
  }
});

Deno.test("getSettings migrates legacy stored settings", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    await kv.set(["settings"], {
      enabled: true,
      skus: ["MK244VC/A"],
      stores: ["R121", "R350"],
    });
    assertEquals(await getSettings(kv), {
      enabled: true,
      watch: ["R121|MK244VC/A", "R350|MK244VC/A"],
    });
  } finally {
    kv.close();
  }
});

Deno.test("toggleWatch adds, removes and ignores unknown pairs", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    await saveSettings(kv, { enabled: true, watch: [] });
    let s = await toggleWatch(kv, "R464", "MK244VC/A");
    assertEquals(s.watch, ["R464|MK244VC/A"]);
    s = await toggleWatch(kv, "R121", "MK254VC/A");
    assertEquals(s.watch, ["R121|MK254VC/A", "R464|MK244VC/A"]);
    s = await toggleWatch(kv, "R464", "MK244VC/A");
    assertEquals(s.watch, ["R121|MK254VC/A"]);
    s = await toggleWatch(kv, "R999", "MK244VC/A");
    assertEquals(s.watch, ["R121|MK254VC/A"]);
    assertEquals((await getSettings(kv)).watch, ["R121|MK254VC/A"]);
  } finally {
    kv.close();
  }
});
