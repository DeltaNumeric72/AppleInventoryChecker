import { ALL_SKUS, STORES } from "../src/catalog.ts";
import {
  DEFAULT_SETTINGS,
  getLastRun,
  getSettings,
  type RunStatus,
  sanitizeSettings,
  saveLastRun,
  saveSettings,
} from "../src/settings.ts";
import { assertEquals } from "./_assert.ts";

Deno.test("sanitizeSettings: drops unknowns, dedupes, coerces", () => {
  const s = sanitizeSettings({
    enabled: false,
    skus: ["MK254VC/A", "MK254VC/A", "BOGUS", 42, "MK244VC/A"],
    stores: ["R464", "R999", "R121", "R121", null],
  });
  assertEquals(s, {
    enabled: false,
    skus: ["MK244VC/A", "MK254VC/A"],
    stores: ["R121", "R464"],
  });
});

Deno.test("sanitizeSettings: bad input yields defaults / empty selections", () => {
  assertEquals(sanitizeSettings(null), DEFAULT_SETTINGS);
  assertEquals(sanitizeSettings("x"), DEFAULT_SETTINGS);
  assertEquals(sanitizeSettings({}), { enabled: true, skus: [], stores: [] });
  assertEquals(sanitizeSettings({ enabled: "yes", skus: "MK244VC/A" }), {
    enabled: false,
    skus: [],
    stores: [],
  });
});

Deno.test("DEFAULT_SETTINGS selects everything", () => {
  assertEquals(DEFAULT_SETTINGS.enabled, true);
  assertEquals(DEFAULT_SETTINGS.skus.length, ALL_SKUS.length);
  assertEquals(DEFAULT_SETTINGS.stores.length, STORES.length);
});

Deno.test("KV round trip for settings and last run", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    assertEquals(await getSettings(kv), DEFAULT_SETTINGS);
    assertEquals(await getLastRun(kv), null);

    await saveSettings(kv, {
      enabled: false,
      skus: ["MK244VC/A", "NOPE"],
      stores: ["R121"],
    });
    assertEquals(await getSettings(kv), {
      enabled: false,
      skus: ["MK244VC/A"],
      stores: ["R121"],
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
