// One stock-check run: load settings, query Apple, notify, record status.

import { checkStores, type FetchFn } from "./apple.ts";
import { PRODUCTS } from "./catalog.ts";
import {
  formatHitsMessage,
  type NtfyConfig,
  ntfyConfigFromEnv,
  sendNtfy,
} from "./notify.ts";
import {
  getLastRun,
  getSettings,
  type Hit,
  type RunStatus,
  saveLastRun,
} from "./settings.ts";

/** Send the failure warning exactly when the counter reaches this value. */
const FAILURE_WARNING_THRESHOLD = 10;

export interface CheckerDeps {
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  ntfy?: NtfyConfig | null;
  now?: () => Date;
}

/** Run one check. Never throws; problems are logged and recorded in the status. */
export async function runCheck(
  kv: Deno.Kv,
  deps: CheckerDeps = {},
): Promise<RunStatus> {
  const ntfy = deps.ntfy === undefined ? ntfyConfigFromEnv() : deps.ntfy;
  const at = (deps.now?.() ?? new Date()).toISOString();
  const status: RunStatus = {
    at,
    ok: true,
    hits: [],
    storesChecked: [],
    storesMissing: [],
    notified: false,
    consecutiveFailures: 0,
  };

  try {
    const settings = await getSettings(kv);
    if (
      !settings.enabled || settings.skus.length === 0 ||
      settings.stores.length === 0
    ) {
      await saveLastRun(kv, status);
      return status;
    }

    try {
      const result = await checkStores(settings.stores, settings.skus, {
        fetchFn: deps.fetchFn,
        sleep: deps.sleep,
      });
      status.hits = result.hits;
      status.storesChecked = result.storesChecked;
      status.storesMissing = result.storesMissing;
      if (result.hits.length > 0 && ntfy) {
        await notifyHits(ntfy, result.hits, deps.fetchFn, status);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const prev = (await getLastRun(kv))?.consecutiveFailures ?? 0;
      status.ok = false;
      status.error = message;
      status.consecutiveFailures = prev + 1;
      console.error("Stock check failed:", message);
      if (status.consecutiveFailures === FAILURE_WARNING_THRESHOLD && ntfy) {
        try {
          await sendNtfy(ntfy, {
            title: `Stock checker failing: ${message}`,
            body:
              `The last ${FAILURE_WARNING_THRESHOLD} checks failed. Latest error: ${message}`,
            priority: 3,
            tags: ["warning"],
          }, deps.fetchFn);
        } catch (err) {
          console.error("Failed to send failure warning:", err);
        }
      }
    }

    await saveLastRun(kv, status);
  } catch (e) {
    // KV or other unexpected failure: log and report without throwing.
    console.error("runCheck error:", e);
    status.ok = false;
    status.error = e instanceof Error ? e.message : String(e);
  }
  return status;
}

async function notifyHits(
  ntfy: NtfyConfig,
  hits: Hit[],
  fetchFn: FetchFn | undefined,
  status: RunStatus,
): Promise<void> {
  const { title, body } = formatHitsMessage(hits);
  try {
    await sendNtfy(ntfy, {
      title,
      body,
      priority: 5,
      tags: ["iphone", "rotating_light"],
      click: PRODUCTS[0].shopUrl,
    }, fetchFn);
    status.notified = true;
  } catch (e) {
    // The check itself succeeded; just record that the push failed.
    console.error("ntfy send failed:", e);
    status.error = `Notification failed: ${e instanceof Error ? e.message : e}`;
  }
}
