// Latest full availability snapshot for every store, persisted in Deno KV.

export interface PartStock {
  available: boolean;
  quote?: string;
}

export interface StoreStock {
  checkedAt: string;
  parts: Record<string, PartStock>;
}

export interface StockSnapshot {
  at: string;
  stores: Record<string, StoreStock>;
}

export async function getSnapshot(kv: Deno.Kv): Promise<StockSnapshot | null> {
  const entry = await kv.get<StockSnapshot>(["stock"]);
  return entry.value;
}

export async function saveSnapshot(
  kv: Deno.Kv,
  s: StockSnapshot,
): Promise<void> {
  await kv.set(["stock"], s);
}

export interface StockPair {
  storeId: string;
  part: string;
}

/**
 * Pairs that flipped between two snapshots. Only stores present in both are
 * compared; with no previous snapshot there are no changes.
 */
export function diffSnapshots(
  prev: StockSnapshot | null,
  next: StockSnapshot,
): { restocks: StockPair[]; soldOuts: StockPair[] } {
  const restocks: StockPair[] = [];
  const soldOuts: StockPair[] = [];
  if (!prev) return { restocks, soldOuts };
  for (const [storeId, nextStore] of Object.entries(next.stores)) {
    const prevStore = prev.stores[storeId];
    if (!prevStore) continue;
    for (const [part, n] of Object.entries(nextStore.parts)) {
      const was = prevStore.parts[part]?.available === true;
      if (!was && n.available) restocks.push({ storeId, part });
      else if (was && !n.available) soldOuts.push({ storeId, part });
    }
  }
  return { restocks, soldOuts };
}
