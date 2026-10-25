// Password-protected settings UI and small JSON API.

import { ALL_SKUS, PRODUCTS, skuLabel, STORES } from "./catalog.ts";
import type { FetchFn } from "./apple.ts";
import { type NtfyConfig, ntfyConfigFromEnv, sendNtfy } from "./notify.ts";
import {
  getLastRun,
  getSettings,
  type RunStatus,
  sanitizeSettings,
  saveSettings,
  type Settings,
} from "./settings.ts";

export interface WebDeps {
  /** ntfy config; `undefined` falls back to env, `null` means not configured. */
  ntfy?: NtfyConfig | null;
  /** Admin password; `undefined` falls back to ADMIN_PASSWORD. */
  adminPassword?: string;
  /** Invoked by POST /run. */
  runCheck?: () => Promise<RunStatus>;
  /** fetch used by POST /test-notify (defaults to global fetch, resolved at call time). */
  fetchFn?: FetchFn;
}

const BASE_HEADERS = { "Cache-Control": "no-store" };

export function escapeHtml(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function isAuthorized(req: Request, password: string): Promise<boolean> {
  const h = req.headers.get("authorization");
  if (!h || !/^basic\s+/i.test(h)) return false;
  let decoded: string;
  try {
    const bin = atob(h.replace(/^basic\s+/i, "").trim());
    decoded = new TextDecoder().decode(
      Uint8Array.from(bin, (c) => c.charCodeAt(0)),
    );
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  return await safeEqual(decoded.slice(idx + 1), password);
}

function sameOrigin(req: Request): boolean {
  const host = new URL(req.url).host;
  for (const name of ["origin", "referer"]) {
    const v = req.headers.get(name);
    if (v === null) continue;
    try {
      if (new URL(v).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function text(body: string, status: number, extra: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...BASE_HEADERS,
      ...extra,
    },
  });
}

function redirect(query: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/?${query}`, ...BASE_HEADERS },
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(d);
}

function storeLabel(id: string): string {
  const s = STORES.find((x) => x.id === id);
  return s ? `${s.name} (${s.city})` : id;
}

const CSS = `
:root{--bg:#f4f5f7;--card:#fff;--fg:#1c1e21;--muted:#65676b;--border:#dcdfe3;--accent:#0a66d6;--accent-fg:#fff;--ok:#1a7f37;--bad:#c62828;--warn-bg:#fff4d6;--ok-bg:#e3f5e8;--bad-bg:#fde7e7}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--card:#1b1e22;--fg:#e8eaed;--muted:#9aa0a6;--border:#2e333a;--accent:#4c9aff;--accent-fg:#0b1220;--ok:#5fd07c;--bad:#ff7b72;--warn-bg:#3a3217;--ok-bg:#15301f;--bad-bg:#3a1b1b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}
h1{font-size:1.3rem;margin:4px 0 12px}
h2{font-size:1rem;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px}
.flash{padding:10px 12px;border-radius:10px;margin-bottom:12px;background:var(--ok-bg)}
.flash.err{background:var(--bad-bg)}
.warn{background:var(--warn-bg);padding:8px 10px;border-radius:8px}
.muted{color:var(--muted)}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
ul.hits{margin:6px 0;padding-left:18px}
table.grid{border-collapse:collapse;width:100%;margin:6px 0}
.grid th,.grid td{padding:6px 4px;text-align:center;border-bottom:1px solid var(--border)}
.grid th:first-child,.grid td:first-child{text-align:left}
label{display:flex;align-items:center;gap:8px;padding:6px 0;min-height:36px}
input[type=checkbox]{width:20px;height:20px;accent-color:var(--accent)}
.stores label{border-bottom:1px solid var(--border)}
.row{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600}
button.mini{padding:2px 8px;font-size:.8rem;border-radius:6px}
footer{color:var(--muted);font-size:.85rem;padding:4px 2px 24px}
`;

const JS = `
document.querySelectorAll('[data-all]').forEach(function(b){
  b.addEventListener('click',function(){
    var boxes=document.querySelectorAll('input[data-'+b.dataset.all+'="'+b.dataset.val+'"]');
    var all=Array.prototype.every.call(boxes,function(x){return x.checked});
    boxes.forEach(function(x){x.checked=!all});
  });
});
`;

function renderStatus(
  lastRun: RunStatus | null,
  ntfy: NtfyConfig | null,
): string {
  const parts: string[] = [`<section class="card"><h2>Status</h2>`];
  if (!lastRun) {
    parts.push(`<p class="muted">No check has run yet.</p>`);
  } else {
    parts.push(
      `<p>Last check: <strong>${escapeHtml(formatTime(lastRun.at))}</strong> ` +
        `<span class="muted">(Toronto)</span> &middot; ` +
        (lastRun.ok
          ? `<span class="ok">OK</span>`
          : `<span class="bad">Error</span>`) +
        `</p>`,
    );
    if (lastRun.error) {
      parts.push(`<p class="bad">${escapeHtml(lastRun.error)}</p>`);
    }
    if (lastRun.hits.length) {
      parts.push(
        `<p>In stock now:</p><ul class="hits">` +
          lastRun.hits.map((h) =>
            `<li>${escapeHtml(h.storeName)} &mdash; ${
              escapeHtml(skuLabel(h.part))
            }` +
            (h.quote ? ` &mdash; ${escapeHtml(h.quote)}` : "") +
            `</li>`
          ).join("") + `</ul>`,
      );
    } else {
      parts.push(`<p class="muted">No stock at selected stores.</p>`);
    }
    if (lastRun.storesMissing.length) {
      parts.push(
        `<p class="muted">Not returned by Apple: ${
          escapeHtml(lastRun.storesMissing.map(storeLabel).join(", "))
        }</p>`,
      );
    }
    parts.push(
      `<p class="muted">Consecutive failures: ${
        escapeHtml(lastRun.consecutiveFailures)
      }</p>`,
    );
  }
  parts.push(
    ntfy
      ? `<p class="muted">ntfy topic: <strong>${
        escapeHtml(ntfy.topic)
      }</strong></p>`
      : `<p class="warn">ntfy is not configured. Set NTFY_TOPIC to receive alerts.</p>`,
  );
  parts.push(`</section>`);
  return parts.join("");
}

function renderSettings(s: Settings): string {
  const skus = new Set(s.skus), stores = new Set(s.stores);
  const caps = [...new Set(ALL_SKUS.map((k) => k.capacity))];
  const colours = [
    ...new Map(ALL_SKUS.map((k) => [k.colorKey, k.colorDisplay])).entries(),
  ];
  const head = colours.map(([key, name]) =>
    `<th>${
      escapeHtml(name)
    }<br><button type="button" class="mini" data-all="color" data-val="${
      escapeHtml(key)
    }" hidden>all</button></th>`
  ).join("");
  const rows = caps.map((cap) => {
    const cells = colours.map(([key]) => {
      const sku = ALL_SKUS.find((k) =>
        k.capacity === cap && k.colorKey === key
      );
      if (!sku) return `<td></td>`;
      return `<td><input type="checkbox" name="sku" value="${
        escapeHtml(sku.part)
      }" data-color="${escapeHtml(key)}" data-cap="${
        escapeHtml(cap)
      }" aria-label="${escapeHtml(skuLabel(sku.part))}"${
        skus.has(sku.part) ? " checked" : ""
      }></td>`;
    }).join("");
    return `<tr><td>${
      escapeHtml(cap)
    } <button type="button" class="mini" data-all="cap" data-val="${
      escapeHtml(cap)
    }" hidden>all</button></td>${cells}</tr>`;
  }).join("");
  const storeRows = STORES.map((st) =>
    `<label><input type="checkbox" name="store" value="${escapeHtml(st.id)}"${
      stores.has(st.id) ? " checked" : ""
    }> <span>${escapeHtml(st.name)} <span class="muted">${
      escapeHtml(st.city)
    }</span></span></label>`
  ).join("");
  return `<form class="card" method="post" action="/settings"><h2>Settings</h2>
<label><input type="checkbox" name="enabled"${
    s.enabled ? " checked" : ""
  }> <strong>Alerts enabled</strong></label>
<h2 style="margin-top:12px">${escapeHtml(PRODUCTS[0].name)} models</h2>
<table class="grid"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table>
<h2 style="margin-top:12px">Stores</h2><div class="stores">${storeRows}</div>
<p><button class="primary" type="submit">Save</button></p></form>`;
}

function flashBanner(url: URL): string {
  const err = url.searchParams.get("error");
  if (err) return `<div class="flash err">${escapeHtml(err)}</div>`;
  const msg = url.searchParams.has("saved")
    ? "Settings saved."
    : url.searchParams.has("tested")
    ? "Test notification sent."
    : url.searchParams.has("ran")
    ? "Check completed."
    : "";
  return msg ? `<div class="flash">${msg}</div>` : "";
}

export function renderPage(
  url: URL,
  settings: Settings,
  lastRun: RunStatus | null,
  ntfy: NtfyConfig | null,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>iPhone Duo Stock Watcher</title><style>${CSS}</style></head><body><main>
<h1>iPhone Duo Stock Watcher</h1>
${flashBanner(url)}
${renderStatus(lastRun, ntfy)}
${renderSettings(settings)}
<section class="card"><h2>Actions</h2><div class="row">
<form method="post" action="/test-notify"><button type="submit">Send test notification</button></form>
<form method="post" action="/run"><button type="submit">Run check now</button></form>
</div></section>
<footer>Checks run every minute, and alerts repeat every minute while an item is in stock.</footer>
</main><script>${JS}document.querySelectorAll('button[hidden]').forEach(function(b){b.hidden=false});</script></body></html>`;
}

const ROUTES: Record<string, string[]> = {
  "/": ["GET", "HEAD"],
  "/api/status": ["GET", "HEAD"],
  "/settings": ["POST"],
  "/test-notify": ["POST"],
  "/run": ["POST"],
};

export function createHandler(
  kv: Deno.Kv,
  deps: WebDeps = {},
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/health" && req.method === "GET") {
      return text("ok", 200);
    }

    const password = deps.adminPassword ?? Deno.env.get("ADMIN_PASSWORD");
    if (!password) {
      return text(
        "ADMIN_PASSWORD is not set. Set the ADMIN_PASSWORD environment variable to enable this app.",
        503,
      );
    }
    if (!(await isAuthorized(req, password))) {
      return text("Authentication required", 401, {
        "WWW-Authenticate":
          'Basic realm="iPhone Duo Stock Watcher", charset="UTF-8"',
      });
    }

    const allowed = ROUTES[url.pathname];
    if (!allowed) return text("Not found", 404);
    if (!allowed.includes(req.method)) {
      return text("Method not allowed", 405, { Allow: allowed.join(", ") });
    }
    if (req.method === "POST" && !sameOrigin(req)) {
      return text("Cross-origin request rejected", 403);
    }

    const ntfy = deps.ntfy === undefined ? ntfyConfigFromEnv() : deps.ntfy;

    switch (url.pathname) {
      case "/": {
        const [settings, lastRun] = await Promise.all([
          getSettings(kv),
          getLastRun(kv),
        ]);
        return new Response(renderPage(url, settings, lastRun, ntfy), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            ...BASE_HEADERS,
          },
        });
      }
      case "/api/status": {
        const [settings, lastRun] = await Promise.all([
          getSettings(kv),
          getLastRun(kv),
        ]);
        return new Response(JSON.stringify({ settings, lastRun }), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...BASE_HEADERS,
          },
        });
      }
      case "/settings": {
        const form = await req.formData().catch(() => null);
        if (!form) return text("Bad form data", 400);
        const settings = sanitizeSettings({
          enabled: form.has("enabled"),
          skus: form.getAll("sku").map(String),
          stores: form.getAll("store").map(String),
        });
        await saveSettings(kv, settings);
        return redirect("saved=1");
      }
      case "/test-notify": {
        if (!ntfy) {
          return redirect(
            "error=" +
              encodeURIComponent("ntfy is not configured (NTFY_TOPIC)"),
          );
        }
        try {
          await sendNtfy(
            ntfy,
            {
              title: "iPhone Duo Stock Watcher",
              body: "Test notification: alerts are working.",
              priority: 3,
              tags: ["white_check_mark"],
            },
            deps.fetchFn ?? ((...a) => fetch(...a)),
          );
          return redirect("tested=1");
        } catch (e) {
          return redirect(
            "error=" + encodeURIComponent(
              `Test notification failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ),
          );
        }
      }
      case "/run": {
        if (!deps.runCheck) {
          return redirect("error=" + encodeURIComponent("Check not available"));
        }
        try {
          await deps.runCheck();
          return redirect("ran=1");
        } catch (e) {
          return redirect(
            "error=" + encodeURIComponent(
              `Check failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
      }
    }
    return text("Not found", 404);
  };
}
