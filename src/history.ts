// Notification history and restock events, kept for 7 days in Deno KV.

export const RETENTION_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_LIMIT = 200;

export interface HistoryEntry {
  at: string;
  kind: "in_stock" | "sold_out" | "warning";
  storeId?: string;
  part?: string;
  message?: string;
}

export interface RestockEvent {
  at: string;
  storeId: string;
  part: string;
}

function isFresh(at: string, now: Date): boolean {
  const t = Date.parse(at);
  return Number.isFinite(t) && t >= now.getTime() - RETENTION_MS;
}

async function append<T extends { at: string }>(
  kv: Deno.Kv,
  name: string,
  items: T[],
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    await kv.set([name, items[i].at, i], items[i], { expireIn: RETENTION_MS });
  }
}

export function appendHistory(
  kv: Deno.Kv,
  entries: HistoryEntry[],
): Promise<void> {
  return append(kv, "history", entries);
}

/** Newest first, entries older than 7 days dropped. */
export async function listHistory(
  kv: Deno.Kv,
  opts: { now?: Date; limit?: number } = {},
): Promise<HistoryEntry[]> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const out: HistoryEntry[] = [];
  if (limit <= 0) return out;
  for await (
    const e of kv.list<HistoryEntry>({ prefix: ["history"] }, { reverse: true })
  ) {
    if (!isFresh(e.value.at, now)) continue;
    out.push(e.value);
    if (out.length >= limit) break;
  }
  return out;
}

export function appendRestocks(
  kv: Deno.Kv,
  events: RestockEvent[],
): Promise<void> {
  return append(kv, "restock", events);
}

/** Oldest first, events older than 7 days dropped. */
export async function listRestocks(
  kv: Deno.Kv,
  opts: { now?: Date } = {},
): Promise<RestockEvent[]> {
  const now = opts.now ?? new Date();
  const out: RestockEvent[] = [];
  for await (const e of kv.list<RestockEvent>({ prefix: ["restock"] })) {
    if (isFresh(e.value.at, now)) out.push(e.value);
  }
  return out;
}
