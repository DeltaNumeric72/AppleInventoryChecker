import {
  diffSnapshots,
  getSnapshot,
  saveSnapshot,
  type StockSnapshot,
} from "../src/stock.ts";
import { assertEquals } from "./_assert.ts";

function snap(
  stores: Record<string, Record<string, boolean>>,
  at = "2026-05-01T12:00:00.000Z",
): StockSnapshot {
  const out: StockSnapshot = { at, stores: {} };
  for (const [id, parts] of Object.entries(stores)) {
    out.stores[id] = {
      checkedAt: at,
      parts: Object.fromEntries(
        Object.entries(parts).map(([p, a]) => [p, { available: a }]),
      ),
    };
  }
  return out;
}

Deno.test("diffSnapshots: null prev has no changes", () => {
  assertEquals(diffSnapshots(null, snap({ R121: { A: true } })), {
    restocks: [],
    soldOuts: [],
  });
});

Deno.test("diffSnapshots: restocks and sold outs", () => {
  const prev = snap({ R121: { A: false, B: true, C: true, D: false } });
  const next = snap({ R121: { A: true, B: false, C: true, D: false } });
  assertEquals(diffSnapshots(prev, next), {
    restocks: [{ storeId: "R121", part: "A" }],
    soldOuts: [{ storeId: "R121", part: "B" }],
  });
});

Deno.test("diffSnapshots: store missing from next is not counted; new stores are not restocks", () => {
  const prev = snap({ R121: { A: true }, R350: { A: true } });
  const next = snap({ R121: { A: true }, R464: { A: true } });
  assertEquals(diffSnapshots(prev, next), { restocks: [], soldOuts: [] });
  // A part new to a known store counts as a restock when available.
  const prev2 = snap({ R121: { A: true } });
  const next2 = snap({ R121: { A: true, B: true } });
  assertEquals(diffSnapshots(prev2, next2).restocks, [
    { storeId: "R121", part: "B" },
  ]);
});

Deno.test("snapshot KV round trip", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    assertEquals(await getSnapshot(kv), null);
    const s = snap({ R121: { A: true } });
    await saveSnapshot(kv, s);
    assertEquals(await getSnapshot(kv), s);
  } finally {
    kv.close();
  }
});
