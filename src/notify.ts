// ntfy push notifications.

import { findSku, PRODUCTS, skuLabel } from "./catalog.ts";
import type { FetchFn } from "./apple.ts";
import type { Hit } from "./settings.ts";

export interface NtfyConfig {
  server: string;
  topic: string;
  token?: string;
}

export function ntfyConfigFromEnv(): NtfyConfig | null {
  const topic = Deno.env.get("NTFY_TOPIC")?.trim();
  if (!topic) return null;
  return {
    server: Deno.env.get("NTFY_SERVER")?.trim() || "https://ntfy.sh",
    topic,
    token: Deno.env.get("NTFY_TOKEN")?.trim() || undefined,
  };
}

/** Summarise all hits in one message, grouped by SKU and then store. */
export function formatHitsMessage(
  hits: Hit[],
): { title: string; body: string } {
  const storeCount = new Set(hits.map((h) => h.storeId)).size;
  const title = `iPhone Duo in stock at ${storeCount} GTA store${
    storeCount === 1 ? "" : "s"
  }`;

  const byPart = new Map<string, string[]>();
  for (const h of hits) {
    const names = byPart.get(h.part) ?? [];
    if (!names.includes(h.storeName)) names.push(h.storeName);
    byPart.set(h.part, names);
  }
  // Catalog order first, unknown parts after.
  const order = PRODUCTS.flatMap((p) => p.skus.map((s) => s.part));
  const parts = [...byPart.keys()].sort((a, b) => {
    const ia = findSku(a) ? order.indexOf(a) : order.length;
    const ib = findSku(b) ? order.indexOf(b) : order.length;
    return ia - ib;
  });
  const body = parts.map((p) => `${skuLabel(p)}: ${byPart.get(p)!.join(", ")}`)
    .join("\n");
  return { title, body };
}

/** Publish via ntfy's JSON API (supports non-ASCII titles). */
export async function sendNtfy(
  cfg: NtfyConfig,
  msg: {
    title: string;
    body: string;
    priority?: 1 | 2 | 3 | 4 | 5;
    tags?: string[];
    click?: string;
  },
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.token) headers["Authorization"] = `Bearer ${cfg.token}`;
  const res = await fetchFn(cfg.server.replace(/\/+$/, "") + "/", {
    method: "POST",
    headers,
    body: JSON.stringify({
      topic: cfg.topic,
      title: msg.title,
      message: msg.body,
      priority: msg.priority,
      tags: msg.tags,
      click: msg.click,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ntfy responded ${res.status}: ${text.slice(0, 200)}`);
  }
}
