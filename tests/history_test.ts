import {
  appendHistory,
  appendRestocks,
  listHistory,
  listRestocks,
  RETENTION_MS,
} from "../src/history.ts";
import { assertEquals } from "./_assert.ts";

const NOW = new Date("2026-05-10T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const DAY = 24 * 3600 * 1000;

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("RETENTION_MS is 7 days", () => {
  assertEquals(RETENTION_MS, 7 * DAY);
});

Deno.test("listHistory: newest first, 7-day cutoff, limit", async () => {
  await withKv(async (kv) => {
    await appendHistory(kv, [{ at: ago(8 * DAY), kind: "in_stock" }]);
    await appendHistory(kv, [{ at: ago(6 * DAY), kind: "in_stock" }]);
    await appendHistory(kv, [
      { at: ago(1 * DAY), kind: "in_stock", storeId: "R121", part: "A" },
      { at: ago(1 * DAY), kind: "sold_out", storeId: "R350", part: "B" },
    ]);
    await appendHistory(kv, [{ at: ago(1000), kind: "warning", message: "w" }]);

    const all = await listHistory(kv, { now: NOW });
    assertEquals(all.map((e) => e.kind), [
      "warning",
      "sold_out",
      "in_stock",
      "in_stock",
    ]);
    assertEquals(all[all.length - 1].at, ago(6 * DAY));

    const two = await listHistory(kv, { now: NOW, limit: 2 });
    assertEquals(two.length, 2);
    assertEquals(two[0].kind, "warning");
    assertEquals((await listHistory(kv, { now: NOW, limit: 0 })).length, 0);
  });
});

Deno.test("listHistory: cutoff moves with injected now", async () => {
  await withKv(async (kv) => {
    await appendHistory(kv, [{ at: ago(6 * DAY), kind: "in_stock" }]);
    const later = new Date(NOW.getTime() + 2 * DAY);
    assertEquals((await listHistory(kv, { now: later })).length, 0);
    assertEquals((await listHistory(kv, { now: NOW })).length, 1);
  });
});

Deno.test("listRestocks: oldest first, 7-day cutoff", async () => {
  await withKv(async (kv) => {
    await appendRestocks(kv, [{ at: ago(9 * DAY), storeId: "R1", part: "A" }]);
    await appendRestocks(kv, [
      { at: ago(2 * DAY), storeId: "R121", part: "A" },
      { at: ago(2 * DAY), storeId: "R121", part: "B" },
    ]);
    await appendRestocks(kv, [{ at: ago(DAY), storeId: "R350", part: "C" }]);
    const out = await listRestocks(kv, { now: NOW });
    assertEquals(out.map((e) => `${e.storeId}:${e.part}`), [
      "R121:A",
      "R121:B",
      "R350:C",
    ]);
  });
});
