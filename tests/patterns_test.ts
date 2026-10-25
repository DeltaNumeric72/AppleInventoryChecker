import { computePatterns } from "../src/patterns.ts";
import type { RestockEvent } from "../src/history.ts";
import { assert, assertEquals } from "./_assert.ts";

// MK244VC/A = Star White 256GB, MK254VC/A = Night Sky 256GB, MK264VC/A = Star White 512GB
const ev = (at: string, storeId: string, part: string): RestockEvent => ({
  at,
  storeId,
  part,
});

Deno.test("Toronto hour/weekday conversion (EDT and EST)", () => {
  // Fri 2026-05-01 12:00Z = 08:00 EDT Friday.
  let p = computePatterns([ev("2026-05-01T12:00:00Z", "R121", "MK244VC/A")]);
  assertEquals(p.byHour[8], 1);
  assertEquals(p.byDay[5], 1);
  // Winter: 2026-01-10 13:00Z (Sat) = 08:00 EST.
  p = computePatterns([ev("2026-01-10T13:00:00Z", "R121", "MK244VC/A")]);
  assertEquals(p.byHour[8], 1);
  assertEquals(p.byDay[6], 1);
});

Deno.test("UTC time on a different local day", () => {
  // Sat 2026-05-02 02:30Z = Fri 22:30 EDT.
  const p = computePatterns([ev("2026-05-02T02:30:00Z", "R121", "MK244VC/A")]);
  assertEquals(p.byHour[22], 1);
  assertEquals(p.byDay[5], 1);
  assertEquals(p.byDay[6], 0);
  assertEquals(p.peakDay, 5);
  assertEquals(p.peakHour, 22);
  // Midnight local is hour 0, not 24.
  const m = computePatterns([ev("2026-05-02T04:05:00Z", "R121", "MK244VC/A")]);
  assertEquals(m.byHour[0], 1);
  assertEquals(m.byDay[6], 1);
  // Another time zone.
  const utc = computePatterns(
    [ev("2026-05-02T02:30:00Z", "R121", "MK244VC/A")],
    {},
    "UTC",
  );
  assertEquals(utc.byHour[2], 1);
  assertEquals(utc.byDay[6], 1);
});

Deno.test("moments de-dup: same store+at counts once in byHour, each in matrix", () => {
  const at = "2026-05-01T12:00:00Z";
  const p = computePatterns([
    ev(at, "R121", "MK244VC/A"),
    ev(at, "R121", "MK254VC/A"),
    ev(at, "R121", "MK264VC/A"),
    ev(at, "R350", "MK244VC/A"),
  ]);
  assertEquals(p.restocks, 4);
  assertEquals(p.moments, 2);
  assertEquals(p.byHour[8], 2);
  assertEquals(p.byDay[5], 2);
  assertEquals(p.byHour.reduce((a, b) => a + b, 0), p.moments);
  assertEquals(p.matrix["starwhite"]["256GB"].count, 2);
  assertEquals(p.matrix["nightsky"]["256GB"].count, 1);
  assertEquals(p.matrix["starwhite"]["512GB"].count, 1);
  assertEquals(p.matrix["nightsky"]["1TB"], { count: 0, typicalHour: null });
});

Deno.test("filters by store, colour, capacity; unknown ignored", () => {
  const events = [
    ev("2026-05-01T12:00:00Z", "R121", "MK244VC/A"),
    ev("2026-05-01T13:00:00Z", "R121", "MK254VC/A"),
    ev("2026-05-01T14:00:00Z", "R350", "MK264VC/A"),
    ev("2026-05-01T14:00:00Z", "R999", "MK244VC/A"),
    ev("2026-05-01T14:00:00Z", "R121", "BOGUS"),
  ];
  assertEquals(computePatterns(events).restocks, 3);
  assertEquals(computePatterns(events, { storeId: "R121" }).restocks, 2);
  assertEquals(computePatterns(events, { colorKey: "starwhite" }).restocks, 2);
  assertEquals(computePatterns(events, { capacity: "512GB" }).restocks, 1);
  const both = computePatterns(events, {
    storeId: "R121",
    colorKey: "nightsky",
    capacity: "256GB",
  });
  assertEquals(both.restocks, 1);
  assertEquals(both.byHour[9], 1);
});

Deno.test("typicalHour: most frequent, ties earliest; empty has null peaks", () => {
  const events = [
    ev("2026-05-01T13:00:00Z", "R121", "MK244VC/A"), // 9am
    ev("2026-05-02T12:00:00Z", "R121", "MK244VC/A"), // 8am
    ev("2026-05-03T13:00:00Z", "R121", "MK244VC/A"), // 9am
    ev("2026-05-04T12:00:00Z", "R121", "MK254VC/A"), // 8am
    ev("2026-05-05T13:00:00Z", "R121", "MK254VC/A"), // 9am (tie)
  ];
  const p = computePatterns(events);
  assertEquals(p.matrix["starwhite"]["256GB"].typicalHour, 9);
  assertEquals(p.matrix["nightsky"]["256GB"].typicalHour, 8);

  const empty = computePatterns([]);
  assertEquals(empty.restocks, 0);
  assertEquals(empty.peakHour, null);
  assertEquals(empty.peakDay, null);
  assertEquals(empty.byHour.length, 24);
  assertEquals(empty.byDay.length, 7);
});

Deno.test("peakHour and peakDay pick the busiest", () => {
  const p = computePatterns([
    ev("2026-05-01T12:00:00Z", "R121", "MK244VC/A"), // Fri 8
    ev("2026-05-08T12:00:00Z", "R121", "MK244VC/A"), // Fri 8
    ev("2026-05-02T15:00:00Z", "R121", "MK244VC/A"), // Sat 11
  ]);
  assertEquals(p.peakHour, 8);
  assertEquals(p.peakDay, 5);
  assert(p.moments === 3);
});
