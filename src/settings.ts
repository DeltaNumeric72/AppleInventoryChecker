// User settings and last-run status, persisted in Deno KV.

import { ALL_SKUS, STORES } from "./catalog.ts";

export interface Settings {
  enabled: boolean;
  skus: string[];
  stores: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  skus: ALL_SKUS.map((s) => s.part),
  stores: STORES.map((s) => s.id),
};

export interface Hit {
  storeId: string;
  storeName: string;
  part: string;
  quote?: string;
}

export interface RunStatus {
  at: string;
  ok: boolean;
  error?: string;
  hits: Hit[];
  storesChecked: string[];
  storesMissing: string[];
  notified: boolean;
  consecutiveFailures: number;
}

/** Keep only known values from `input`, de-duplicated, in catalog order. */
function pickKnown(input: unknown, known: string[]): string[] {
  if (!Array.isArray(input)) return [];
  const wanted = new Set(
    input.filter((v): v is string => typeof v === "string"),
  );
  return known.filter((k) => wanted.has(k));
}

/**
 * Coerce arbitrary input (form data, stored JSON) into valid Settings.
 * Unknown parts/stores are dropped; a missing `enabled` defaults to true.
 */
export function sanitizeSettings(input: unknown): Settings {
  if (typeof input !== "object" || input === null) {
    return {
      ...DEFAULT_SETTINGS,
      skus: [...DEFAULT_SETTINGS.skus],
      stores: [...DEFAULT_SETTINGS.stores],
    };
  }
  const o = input as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === "boolean"
      ? o.enabled
      : o.enabled === undefined,
    skus: pickKnown(o.skus, ALL_SKUS.map((s) => s.part)),
    stores: pickKnown(o.stores, STORES.map((s) => s.id)),
  };
}

export async function getSettings(kv: Deno.Kv): Promise<Settings> {
  const entry = await kv.get(["settings"]);
  if (entry.value === null) return sanitizeSettings(undefined);
  return sanitizeSettings(entry.value);
}

export async function saveSettings(kv: Deno.Kv, s: Settings): Promise<void> {
  await kv.set(["settings"], sanitizeSettings(s));
}

export async function getLastRun(kv: Deno.Kv): Promise<RunStatus | null> {
  const entry = await kv.get<RunStatus>(["lastRun"]);
  return entry.value;
}

export async function saveLastRun(kv: Deno.Kv, r: RunStatus): Promise<void> {
  await kv.set(["lastRun"], r);
}
