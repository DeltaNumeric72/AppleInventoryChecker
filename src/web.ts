// Password-protected UI (Stock / Recent changes / Patterns / Settings) and a
// small JSON API. Server-rendered HTML with inline CSS; works without JS.

import {
  ALL_SKUS,
  CAPACITIES,
  COLORS,
  findStore,
  PRODUCTS,
  shortLabel,
  skuFor,
  STORES,
} from "./catalog.ts";
import type { FetchFn } from "./apple.ts";
import { type NtfyConfig, ntfyConfigFromEnv, sendNtfy } from "./notify.ts";
import {
  computePatterns,
  type PatternFilter,
  type Patterns,
} from "./patterns.ts";
import {
  type HistoryEntry,
  listHistory,
  listRestocks,
  type RestockEvent,
} from "./history.ts";
import { getSnapshot, type StockSnapshot } from "./stock.ts";
import {
  getLastRun,
  getSettings,
  pairKey,
  type RunStatus,
  sanitizeSettings,
  saveSettings,
  type Settings,
  toggleWatch,
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
  /** Clock override (tests, screenshots). */
  now?: () => Date;
}

const BASE_HEADERS = { "Cache-Control": "no-store" };
const TZ = "America/Toronto";
const TABS = [
  ["stock", "Stock"],
  ["changes", "Recent changes"],
  ["patterns", "Patterns"],
  ["settings", "Settings"],
] as const;
type Tab = typeof TABS[number][0];
const STALE_MS = 5 * 60 * 1000;

export function escapeHtml(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

const esc = escapeHtml;

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

function redirect(query: string, hash = ""): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/?${query}${hash ? "#" + hash : ""}`,
      ...BASE_HEADERS,
    },
  });
}

function parseTab(v: string | null | undefined): Tab {
  return TABS.find(([k]) => k === v)?.[0] ?? "stock";
}

// ---------------------------------------------------------------- time ----

const LOCAL_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface Local {
  date: string;
  weekday: string;
  hh: string;
  mm: string;
}

function local(iso: string | Date): Local | null {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return null;
  const o: Record<string, string> = {};
  for (const p of LOCAL_FMT.formatToParts(d)) o[p.type] = p.value;
  const hh = (o.hour ?? "00").replace(/^24$/, "00");
  return {
    date: `${o.year}-${o.month}-${o.day}`,
    weekday: o.weekday ?? "",
    hh,
    mm: o.minute ?? "00",
  };
}

/** "13:03" in Toronto time. */
function clock(iso: string): string {
  const l = local(iso);
  return l ? `${l.hh}:${l.mm}` : iso;
}

/** "Sat 08:31". */
function dayClock(iso: string): string {
  const l = local(iso);
  return l ? `${l.weekday} ${l.hh}:${l.mm}` : iso;
}

/** "today 14:26", "yesterday 14:26" or "Sat 14:26". */
function relativeClock(iso: string, now: Date): string {
  const l = local(iso);
  if (!l) return iso;
  const today = local(now)?.date;
  const yesterday = local(new Date(now.getTime() - 24 * 3600 * 1000))?.date;
  const when = l.date === today
    ? "today"
    : l.date === yesterday
    ? "yesterday"
    : l.weekday;
  return `${when} ${l.hh}:${l.mm}`;
}

/** 0 -> "12am", 13 -> "1pm". */
function hourLabel(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  const suffix = hh < 12 ? "am" : "pm";
  return `${hh % 12 === 0 ? 12 : hh % 12}${suffix}`;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// ----------------------------------------------------------------- CSS ----

const CHIPS: Record<string, { bg: string; fg: string }> = {
  nightsky: { bg: "#1f2430", fg: "#ffffff" },
  starwhite: { bg: "#ecebe6", fg: "#1c1e21" },
};
const FALLBACK_CHIP = { bg: "#d5d8df", fg: "#1c1e21" };

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--panel:#eef0f5;--panel2:#e2e5ed;--fg:#1d2433;--muted:#6b7385;--line:#dde1ea;--accent:#1f3a7a;--accent-soft:#e4ebfa;--ok:#4a9a5b;--ok-fg:#fff;--ok-text:#2f7d43;--bad:#b3261e;--bad-bg:#f9dcda;--ok-bg:#d9f0df;--notify-bg:#faedc4;--notify-fg:#6f5200;--warn-bg:#fff3cf;--warn-fg:#6f5200;--g:74 154 91;--bar:#2f6b4a;--bar-peak:#22a05a;--stub:#dde1ea;--chipline:#c9cdd8}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d1017;--panel:#171c27;--panel2:#212838;--fg:#e6e9f0;--muted:#98a0b3;--line:#262d3d;--accent:#9db8ff;--accent-soft:#1d2842;--ok:#3d8c52;--ok-text:#6ccf88;--bad:#ff8a80;--bad-bg:#3d1d1b;--ok-bg:#16301f;--notify-bg:#40340f;--notify-fg:#f1cd70;--warn-bg:#3a3012;--warn-fg:#f1cd70;--g:90 190 120;--bar:#2f6b4a;--bar-peak:#3fc57a;--stub:#2a3142;--chipline:#3a4258}}
:root[data-theme=dark]{--bg:#0d1017;--panel:#171c27;--panel2:#212838;--fg:#e6e9f0;--muted:#98a0b3;--line:#262d3d;--accent:#9db8ff;--accent-soft:#1d2842;--ok:#3d8c52;--ok-text:#6ccf88;--bad:#ff8a80;--bad-bg:#3d1d1b;--ok-bg:#16301f;--notify-bg:#40340f;--notify-fg:#f1cd70;--warn-bg:#3a3012;--warn-fg:#f1cd70;--g:90 190 120;--bar:#2f6b4a;--bar-peak:#3fc57a;--stub:#2a3142;--chipline:#3a4258}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:1200px;margin:0 auto;padding:22px 16px 40px}
a{color:var(--accent)}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid var(--line)}
.eyebrow{font-size:.78rem;font-weight:700;letter-spacing:.24em;color:var(--accent);margin:0 0 2px}
h1{font-size:1.6rem;line-height:1.15;margin:0;color:var(--fg)}
.checked{color:var(--muted);font-size:.95rem}
nav.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:18px;overflow-x:auto}
nav.tabs a{padding:14px 16px 12px;font-weight:600;color:var(--muted);text-decoration:none;border-bottom:3px solid transparent;margin-bottom:-1px;white-space:nowrap}
nav.tabs a:hover{color:var(--fg)}
@media (max-width:480px){nav.tabs{gap:0}nav.tabs a{padding:12px 9px 10px;font-size:14px}}
nav.tabs a[aria-current=page]{color:var(--accent);border-bottom-color:var(--accent)}
.summary{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 16px}
.summary p{margin:0}
.pill-btn{display:inline-block;background:var(--accent);color:var(--bg);font-weight:700;padding:9px 18px;border-radius:999px;text-decoration:none;font-size:.95rem}
.note{margin:0 0 10px;padding:9px 12px;border-radius:10px;background:var(--warn-bg);color:var(--warn-fg);font-size:.93rem}
.note.err{background:var(--bad-bg);color:var(--bad)}
.note.ok{background:var(--ok-bg);color:var(--ok-text)}
.muted{color:var(--muted)}
.stores{display:grid;grid-template-columns:1fr;gap:16px}
@media(min-width:700px){.stores{grid-template-columns:repeat(2,1fr)}}
@media(min-width:1040px){.stores{grid-template-columns:repeat(3,1fr)}}
.store{background:var(--panel);border-radius:18px;padding:18px 14px 14px;text-align:center;scroll-margin-top:12px}
.store:target{outline:2px solid var(--accent)}
.store h2{margin:0 0 6px;font-size:1.2rem;color:var(--accent)}
.badge{display:inline-block;border:1px solid var(--chipline);border-radius:999px;padding:1px 10px;font-size:.82rem;font-weight:600;color:var(--muted)}
.badge.avail{background:var(--ok);border-color:var(--ok);color:var(--ok-fg)}
.addr{display:block;margin:8px 0 0;font-size:.95rem}
.phone{display:block;margin:2px 0 8px;font-size:.92rem;color:var(--muted);text-decoration:none}
.restock{display:inline-block;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:.8rem;color:var(--muted);margin:0 0 6px}
.stale{font-size:.8rem;color:var(--warn-fg);background:var(--warn-bg);border-radius:8px;padding:2px 8px;display:inline-block;margin:0 0 6px}
table.cells{width:100%;border-collapse:separate;border-spacing:6px;table-layout:fixed;margin-top:2px}
table.cells th{font-size:.78rem;font-weight:700;color:var(--muted);padding:0}
table.cells th.c0,table.cells td.c0{width:30%}
table.cells td{padding:0;height:44px}
table.cells form{margin:0;height:100%}
.chip{display:block;border:1px solid var(--chipline);border-radius:9px;padding:0 4px;font-size:.82rem;font-weight:600;height:44px;line-height:42px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cell{position:relative;width:100%;height:44px;border-radius:9px;border:1px dashed var(--chipline);background:transparent;color:var(--muted);font:inherit;font-size:.92rem;font-weight:600;cursor:pointer;padding:0}
.cell:hover{filter:brightness(.96)}
.cell:focus-visible,.pill-btn:focus-visible,nav.tabs a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cell.watch{background:var(--notify-bg);border:1px solid transparent;color:var(--notify-fg)}
.cell.watch small{font-size:.7rem;margin-right:2px}
.cell.in{background:var(--ok);border:1px solid transparent;color:var(--ok-fg);font-size:1.45rem;line-height:1}
.cell .bell{position:absolute;top:1px;right:3px;font-size:.62rem;line-height:1}
.foot{color:var(--muted);font-size:.85rem;margin-top:22px}
h2.sec{font-size:1.15rem;margin:6px 0 4px;color:var(--fg)}
p.sub{color:var(--muted);margin:0 0 14px;font-size:.95rem;max-width:70ch}
.hist{background:var(--panel);border-radius:14px;padding:10px 14px;margin:0;list-style:none}
.hist li{display:flex;align-items:center;gap:10px;padding:6px 0;flex-wrap:wrap}
.hist time{color:var(--muted);font-size:.92rem;min-width:5.6em;font-variant-numeric:tabular-nums}
.tag{display:inline-block;border-radius:999px;padding:1px 10px;font-size:.74rem;font-weight:800;letter-spacing:.06em}
.tag.in_stock{background:var(--ok-bg);color:var(--ok-text)}
.tag.sold_out{background:var(--bad-bg);color:var(--bad)}
.tag.warning{background:var(--warn-bg);color:var(--warn-fg)}
.filters{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 18px}
.filters select{flex:1 1 180px;min-width:0;font:inherit;font-weight:600;color:var(--accent);background:var(--panel);border:1px solid var(--chipline);border-radius:12px;padding:10px 12px}
h3.eb{font-size:.8rem;letter-spacing:.2em;color:var(--accent);margin:24px 0 4px;text-transform:uppercase}
table.matrix{width:100%;border-collapse:separate;border-spacing:6px;table-layout:fixed;margin:4px 0 8px}
table.matrix th{font-size:.82rem;color:var(--accent);font-weight:700;padding:2px 0}
table.matrix th.rl{text-align:left;color:var(--fg);width:26%;white-space:nowrap}
.dot{display:inline-block;width:14px;height:14px;border-radius:50%;border:1px solid var(--chipline);vertical-align:-2px;margin-right:6px}
table.matrix td{text-align:center;border-radius:10px;padding:8px 2px;background:var(--panel);color:var(--muted);height:52px;line-height:1.15}
table.matrix td.has{background:rgb(var(--g) / var(--a));color:var(--fg)}
table.matrix td b{display:block;font-size:1.05rem}
table.matrix td small{font-size:.72rem;opacity:.85}
table.matrix td.tot,table.matrix tr.tr td{background:none;height:auto;padding:4px 0;font-weight:700;color:var(--accent)}
table.matrix tr.tr th{color:var(--fg)}
.say{margin:10px 0 0}
.say b{color:var(--ok-text)}
.chart{display:flex;align-items:flex-end;gap:3px;height:190px;margin-top:10px}
.chart.days{gap:8px}
.col{flex:1 1 0;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
.col .n{font-size:.78rem;font-weight:700;color:var(--muted);margin-bottom:2px}
.col .bar{width:100%;background:var(--bar);border-radius:5px 5px 0 0}
.col.peak .bar{background:var(--bar-peak)}
.col .bar.zero{height:3px!important;background:var(--stub);border-radius:2px}
.axis{display:flex;gap:3px;margin-top:4px;color:var(--muted);font-size:.78rem}
.axis.days{gap:8px;font-size:.9rem}
.axis span{flex:1 1 0;min-width:0;white-space:nowrap}
.axis.days span{text-align:center}
.card{background:var(--panel);border-radius:16px;padding:16px;margin-bottom:16px;max-width:760px}
.card h2{margin:0 0 6px;font-size:1.1rem}
.card p{margin:6px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button.btn{font:inherit;font-weight:600;padding:9px 16px;border-radius:999px;border:1px solid var(--chipline);background:var(--bg);color:var(--fg);cursor:pointer}
button.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
button.btn.danger{color:var(--bad)}
label.chk{display:inline-flex;align-items:center;gap:8px;padding:6px 14px 6px 0;min-height:36px}
label.chk.block{display:flex}
input[type=checkbox]{width:18px;height:18px;accent-color:var(--accent)}
fieldset{border:0;padding:0;margin:10px 0}
legend{font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700;padding:0}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:8px 0 0}
dl.kv dt{color:var(--muted)}dl.kv dd{margin:0}
`;

const JS =
  `document.querySelectorAll('form.filters select').forEach(function(s){s.addEventListener('change',function(){s.form.submit()})});`;

// ------------------------------------------------------------ rendering ----

interface PageData {
  url: URL;
  tab: Tab;
  now: Date;
  settings: Settings;
  lastRun: RunStatus | null;
  snapshot: StockSnapshot | null;
  history: HistoryEntry[];
  restocks: RestockEvent[];
  ntfy: NtfyConfig | null;
}

function storeName(id: string): string {
  return findStore(id)?.name ?? id;
}

function mapsUrl(name: string, address: string): string {
  return "https://www.google.com/maps/search/?api=1&query=" +
    encodeURIComponent(`Apple ${name} ${address}`);
}

function availableCount(snapshot: StockSnapshot | null, storeId?: string) {
  if (!snapshot) return 0;
  let n = 0;
  for (const st of STORES) {
    if (storeId && st.id !== storeId) continue;
    const parts = snapshot.stores[st.id]?.parts ?? {};
    for (const sku of ALL_SKUS) if (parts[sku.part]?.available) n++;
  }
  return n;
}

function renderHeader(d: PageData): string {
  const checked = d.snapshot
    ? `checked ${clock(d.snapshot.at)}`
    : "not checked yet";
  const tabs = TABS.map(([key, label]) =>
    `<a href="/?tab=${key}"${key === d.tab ? ' aria-current="page"' : ""}>${
      esc(label)
    }</a>`
  ).join("");
  return `<header class="top"><div><p class="eyebrow">RESULTS · 🇨🇦 CANADA</p><h1>${
    esc(PRODUCTS[0].name)
  }</h1></div><div class="checked">${esc(checked)}</div></header>
<nav class="tabs" aria-label="Sections">${tabs}</nav>`;
}

function renderNotes(d: PageData): string {
  const out: string[] = [];
  const u = d.url.searchParams;
  if (u.get("error")) {
    out.push(`<p class="note err" role="alert">${esc(u.get("error"))}</p>`);
  } else if (u.has("saved")) {
    out.push(`<p class="note ok">Settings saved.</p>`);
  } else if (u.has("tested")) {
    out.push(`<p class="note ok">Test notification sent.</p>`);
  } else if (u.has("ran")) {
    out.push(`<p class="note ok">Check completed.</p>`);
  }
  if (!d.settings.enabled) {
    out.push(
      `<p class="note">Alerts are turned off. <a href="/?tab=settings">Turn them on</a> to get notified.</p>`,
    );
  }
  if (!d.ntfy) {
    out.push(
      `<p class="note">ntfy is not configured. Set NTFY_TOPIC to receive alerts.</p>`,
    );
  }
  if (d.lastRun && !d.lastRun.ok) {
    out.push(
      `<p class="note err">Last check failed${
        d.lastRun.error ? `: ${esc(d.lastRun.error)}` : ""
      }</p>`,
    );
  }
  return out.join("");
}

function restockPill(d: PageData, storeId: string): string {
  const events = d.restocks.filter((e) => e.storeId === storeId);
  if (!events.length) {
    return `<div class="restock">No restocks logged yet this week</div>`;
  }
  const last = events.reduce((a, b) => (b.at > a ? b.at : a), events[0].at);
  const p = computePatterns(events, { storeId });
  const usual = p.peakHour === null
    ? ""
    : ` · usually around ${hourLabel(p.peakHour)}`;
  return `<div class="restock">↻ Last restock ${
    esc(relativeClock(last, d.now))
  }${usual} · restocked ${p.moments} ${
    p.moments === 1 ? "time" : "times"
  } this week</div>`;
}

function renderStoreCard(d: PageData, storeId: string): string {
  const st = findStore(storeId)!;
  const data = d.snapshot?.stores[st.id];
  const n = availableCount(d.snapshot, st.id);
  const badge = n > 0
    ? `<span class="badge avail">${n} option${
      n === 1 ? "" : "s"
    } available</span>`
    : `<span class="badge">None available</span>`;
  const watch = new Set(d.settings.watch);
  let note = "";
  if (!data) {
    note = `<div class="stale">Not checked yet</div>`;
  } else if (d.now.getTime() - Date.parse(data.checkedAt) > STALE_MS) {
    note = `<div class="stale">Stale · last checked ${
      esc(clock(data.checkedAt))
    }</div>`;
  }
  const head = CAPACITIES.map((c) => `<th scope="col">${esc(c)}</th>`).join("");
  const rows = COLORS.map((c) => {
    const chip = CHIPS[c.key] ?? FALLBACK_CHIP;
    const cells = CAPACITIES.map((cap) => {
      const sku = skuFor(c.key, cap);
      if (!sku) return `<td></td>`;
      const watched = watch.has(pairKey(st.id, sku.part));
      const ps = data?.parts[sku.part];
      const label = shortLabel(sku.part);
      let btn: string;
      if (ps?.available) {
        const q = ps.quote ? ` — ${ps.quote}` : "";
        btn =
          `<button class="cell in" type="submit" aria-pressed="${watched}" aria-label="${
            esc(
              `In stock${q}. ${label}. ${
                watched ? "Watching" : "Not watching"
              }`,
            )
          }" title="${esc(`In stock${q}`)}">✓${
            watched ? `<span class="bell" aria-hidden="true">🔔</span>` : ""
          }</button>`;
      } else if (watched) {
        btn =
          `<button class="cell watch" type="submit" aria-pressed="true" aria-label="${
            esc(`Notify on: ${label}`)
          }" title="Watching — click to stop"><small aria-hidden="true">🔔</small>Notify</button>`;
      } else {
        btn =
          `<button class="cell" type="submit" aria-pressed="false" aria-label="${
            esc(`Notify off: ${label}`)
          }" title="Not watching — click to get notified">Notify</button>`;
      }
      return `<td><form method="post" action="/toggle"><input type="hidden" name="store" value="${
        esc(st.id)
      }"><input type="hidden" name="part" value="${
        esc(sku.part)
      }">${btn}</form></td>`;
    }).join("");
    return `<tr><th scope="row" class="c0"><span class="chip" style="background:${chip.bg};color:${chip.fg}">${
      esc(c.display)
    }</span></th>${cells}</tr>`;
  }).join("");
  return `<section class="store" id="${esc(st.id)}"><h2>${esc(st.name)}</h2>
<div>${badge}</div>
<a class="addr" href="${
    esc(mapsUrl(st.name, st.address))
  }" target="_blank" rel="noopener">${esc(st.address)}</a>
<a class="phone" href="tel:${esc(st.phone.replace(/[^0-9+]/g, ""))}">${
    esc(st.phone)
  }</a>
${restockPill(d, st.id)}${note}
<table class="cells"><thead><tr><th class="c0"></th>${head}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderStock(d: PageData): string {
  const n = availableCount(d.snapshot);
  const summary = !d.snapshot
    ? "No check has run yet."
    : n > 0
    ? `<strong>${n}</strong> colour/size option${
      n === 1 ? "" : "s"
    } available across ${STORES.length} stores`
    : `Nothing in stock at your ${STORES.length} stores right now`;
  return `<div class="summary"><p>${summary}</p><a class="pill-btn" href="/?tab=settings">🔔 Set an alert</a></div>
${renderNotes(d)}
<div class="stores">${
    STORES.map((s) => renderStoreCard(d, s.id)).join("")
  }</div>
<p class="foot">Checks run every minute, and alerts repeat every minute while an item is in stock. Tap a cell to turn its Notify on or off.</p>`;
}

function renderChanges(d: PageData): string {
  const items = d.history.map((h) => {
    const label = h.kind === "in_stock"
      ? "IN STOCK"
      : h.kind === "sold_out"
      ? "SOLD OUT"
      : "WARNING";
    const body = h.kind === "warning"
      ? esc(h.message ?? "Warning")
      : `${esc(h.part ? shortLabel(h.part) : "")}${
        h.storeId ? ` at ${esc(storeName(h.storeId))}` : ""
      }`;
    return `<li><time datetime="${esc(h.at)}">${
      esc(dayClock(h.at))
    }</time><span class="tag ${h.kind}">${label}</span><span>${body}</span></li>`;
  }).join("");
  return `${renderNotes(d)}<h2 class="sec">Notification history</h2>
<p class="sub">Alerts sent for the store/model combinations you're watching, last 7 days.</p>
${
    items
      ? `<ul class="hist">${items}</ul>`
      : `<p class="muted">Nothing yet. When a watched model comes into stock or sells out, it will be listed here with the time.</p>`
  }`;
}

function selectHtml(
  name: string,
  allLabel: string,
  options: [string, string][],
  current: string | undefined,
): string {
  return `<select name="${name}" aria-label="${
    esc(allLabel)
  }"><option value="">${esc(allLabel)}</option>${
    options.map(([v, l]) =>
      `<option value="${esc(v)}"${v === current ? " selected" : ""}>${
        esc(l)
      }</option>`
    ).join("")
  }</select>`;
}

function renderMatrix(p: Patterns): string {
  let max = 0;
  for (const c of COLORS) {
    for (const cap of CAPACITIES) {
      max = Math.max(max, p.matrix[c.key][cap].count);
    }
  }
  const colTotals = CAPACITIES.map((cap) =>
    COLORS.reduce((s, c) => s + p.matrix[c.key][cap].count, 0)
  );
  const rows = COLORS.map((c) => {
    const chip = CHIPS[c.key] ?? FALLBACK_CHIP;
    let rowTotal = 0;
    const cells = CAPACITIES.map((cap) => {
      const cell = p.matrix[c.key][cap];
      rowTotal += cell.count;
      if (!cell.count) return `<td>–</td>`;
      const a = (0.2 + 0.6 * (cell.count / max)).toFixed(2);
      return `<td class="has" style="--a:${a}"><b>${cell.count}</b>${
        cell.typicalHour === null
          ? ""
          : `<small>~${hourLabel(cell.typicalHour)}</small>`
      }</td>`;
    }).join("");
    return `<tr><th scope="row" class="rl"><span class="dot" style="background:${chip.bg}"></span>${
      esc(c.display)
    }</th>${cells}<td class="tot">${rowTotal}</td></tr>`;
  }).join("");
  return `<table class="matrix"><thead><tr><th></th>${
    CAPACITIES.map((c) => `<th scope="col">${esc(c)}</th>`).join("")
  }<th scope="col">Total</th></tr></thead><tbody>${rows}<tr class="tr"><th scope="row" class="rl">Total</th>${
    colTotals.map((t) => `<td>${t}</td>`).join("")
  }<td>${p.restocks}</td></tr></tbody></table>`;
}

function renderBars(
  values: number[],
  labels: string[],
  peak: number | null,
  days: boolean,
): string {
  const max = Math.max(0, ...values);
  const cols = values.map((v, i) => {
    const h = v > 0 && max > 0 ? Math.max(4, Math.round((v / max) * 100)) : 0;
    return `<div class="col${i === peak ? " peak" : ""}" title="${
      esc(`${labels[i]}: ${v}`)
    }">${v > 0 ? `<span class="n">${v}</span>` : ""}<div class="bar${
      v > 0 ? "" : " zero"
    }" style="height:${h}%"></div></div>`;
  }).join("");
  return `<div class="chart${days ? " days" : ""}" role="img" aria-label="${
    esc(labels.map((l, i) => `${l} ${values[i]}`).join(", "))
  }">${cols}</div>`;
}

function renderPatterns(d: PageData): string {
  const q = d.url.searchParams;
  const storeId = STORES.find((s) => s.id === q.get("store"))?.id;
  const colorKey = COLORS.find((c) => c.key === q.get("color"))?.key;
  const capacity = CAPACITIES.find((c) => c === q.get("size"));
  const filter: PatternFilter = { storeId, colorKey, capacity };
  const p = computePatterns(d.restocks, filter);

  const say = p.restocks === 0 || p.peakHour === null || p.peakDay === null
    ? "No restocks logged yet for this selection."
    : `Most restocks arrive around <b>${hourLabel(p.peakHour)}–${
      hourLabel(p.peakHour + 1)
    }</b>, and the busiest day is <b>${
      DAY_NAMES[p.peakDay]
    }</b>. Based on ${p.restocks} restock${p.restocks === 1 ? "" : "s"}.`;

  const hourLabels = Array.from({ length: 24 }, (_, h) => hourLabel(h));
  const hourAxis = hourLabels.map((l, h) =>
    `<span>${h % 3 === 0 ? l : ""}</span>`
  ).join("");
  const dayShort = DAY_NAMES.map((n) => n.slice(0, 3));
  const dayAxis = dayShort.map((l) => `<span>${l}</span>`).join("");

  return `${renderNotes(d)}<h2 class="sec">When does stock come in? · ${
    esc(PRODUCTS[0].name)
  }</h2>
<p class="sub">Restocks logged over the last 7 days at your ${STORES.length} stores, in Toronto time.</p>
<form class="filters" method="get" action="/"><input type="hidden" name="tab" value="patterns">${
    selectHtml(
      "store",
      "All stores",
      STORES.map((s) => [s.id, s.name]),
      storeId,
    )
  }${
    selectHtml(
      "color",
      "All colours",
      COLORS.map((c) => [c.key, c.display]),
      colorKey,
    )
  }${
    selectHtml("size", "All sizes", CAPACITIES.map((c) => [c, c]), capacity)
  }<noscript><button class="btn primary" type="submit">Apply</button></noscript></form>
<h3 class="eb">By colour and size</h3>
<p class="sub">Number of restocks for each configuration, and when it usually arrives.</p>
${renderMatrix(p)}
<p class="say">${say}</p>
<h3 class="eb">By time of day</h3>
${renderBars(p.byHour, hourLabels, p.peakHour, false)}
<div class="axis">${hourAxis}</div>
<h3 class="eb">By day of the week</h3>
${renderBars(p.byDay, DAY_NAMES, p.peakDay, true)}
<div class="axis days">${dayAxis}</div>
<p class="foot">Bars count restock moments: a store getting several colours or sizes in the same check counts once.</p>`;
}

function renderSettings(d: PageData): string {
  const { settings: s, lastRun: r, ntfy } = d;
  const total = STORES.length * ALL_SKUS.length;
  const colourBoxes = COLORS.map((c) =>
    `<label class="chk"><input type="checkbox" name="color" value="${
      esc(c.key)
    }" checked> ${esc(c.display)}</label>`
  ).join("");
  const sizeBoxes = CAPACITIES.map((c) =>
    `<label class="chk"><input type="checkbox" name="size" value="${
      esc(c)
    }" checked> ${esc(c)}</label>`
  ).join("");
  const storeBoxes = STORES.map((st) =>
    `<label class="chk"><input type="checkbox" name="store" value="${
      esc(st.id)
    }" checked> ${esc(st.name)}</label>`
  ).join("");
  const last = !r
    ? `<p class="muted">No check has run yet.</p>`
    : `<dl class="kv"><dt>Last check</dt><dd>${
      esc(dayClock(r.at))
    } (Toronto) · ${r.ok ? "OK" : "<strong>Error</strong>"}</dd>${
      r.error ? `<dt>Error</dt><dd>${esc(r.error)}</dd>` : ""
    }<dt>In stock (watched)</dt><dd>${
      r.hits.length
        ? r.hits.map((h) => `${esc(shortLabel(h.part))} at ${esc(h.storeName)}`)
          .join("; ")
        : "none"
    }</dd><dt>Consecutive failures</dt><dd>${r.consecutiveFailures}</dd>${
      r.storesMissing.length
        ? `<dt>Not returned by Apple</dt><dd>${
          esc(r.storesMissing.map(storeName).join(", "))
        }</dd>`
        : ""
    }</dl>`;
  return `${renderNotes(d)}<h2 class="sec">Settings</h2>
<form class="card" method="post" action="/settings"><input type="hidden" name="alerts_form" value="1">
<h2>Alerts</h2>
<label class="chk"><input type="checkbox" name="enabled"${
    s.enabled ? " checked" : ""
  }> <strong>Alerts enabled</strong></label>
<p class="muted">Stock is still tracked while alerts are off; only notifications stop.</p>
<p><button class="btn primary" type="submit">Save</button></p></form>
<form class="card" method="post" action="/settings"><h2>Bulk watch tool</h2>
<p class="muted">Pick colours, sizes and stores, then replace, add to or remove from your watch list. This edits the same per-cell Notify toggles on the Stock tab. Currently watching <strong>${s.watch.length}</strong> of ${total} combinations.</p>
<fieldset><legend>Colours</legend>${colourBoxes}</fieldset>
<fieldset><legend>Sizes</legend>${sizeBoxes}</fieldset>
<fieldset><legend>Stores</legend>${storeBoxes}</fieldset>
<div class="row"><button class="btn primary" type="submit" name="mode" value="replace">Replace watch list</button><button class="btn" type="submit" name="mode" value="add">Add</button><button class="btn danger" type="submit" name="mode" value="remove">Remove</button></div></form>
<section class="card"><h2>Notifications</h2>${
    ntfy
      ? `<p>ntfy topic: <strong>${
        esc(ntfy.topic)
      }</strong> <span class="muted">(${esc(ntfy.server)})</span></p>`
      : `<p>ntfy is not configured. Set NTFY_TOPIC to receive alerts.</p>`
  }<div class="row"><form method="post" action="/test-notify"><input type="hidden" name="return" value="settings"><button class="btn" type="submit">Send test notification</button></form><form method="post" action="/run"><input type="hidden" name="return" value="settings"><button class="btn" type="submit">Run check now</button></form></div></section>
<section class="card"><h2>Last run</h2>${last}</section>`;
}

export function renderPage(d: PageData): string {
  const body = d.tab === "stock"
    ? renderStock(d)
    : d.tab === "changes"
    ? renderChanges(d)
    : d.tab === "patterns"
    ? renderPatterns(d)
    : renderSettings(d);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">${
    d.tab === "stock" ? `<meta http-equiv="refresh" content="60">` : ""
  }
<title>iPhone Duo Stock Watcher</title><style>${CSS}</style></head><body><main>
${renderHeader(d)}
${body}
</main><script>${JS}</script></body></html>`;
}

// -------------------------------------------------------------- handler ----

const ROUTES: Record<string, string[]> = {
  "/": ["GET", "HEAD"],
  "/api/status": ["GET", "HEAD"],
  "/settings": ["POST"],
  "/toggle": ["POST"],
  "/test-notify": ["POST"],
  "/run": ["POST"],
};

/** Colour x size x store product as pair keys. */
function bulkPairs(form: FormData): string[] {
  const parts = form.getAll("color").flatMap((c) =>
    form.getAll("size").map((z) => skuFor(String(c), String(z))?.part)
  ).filter((p): p is string => !!p);
  return form.getAll("store").flatMap((st) =>
    parts.map((p) => pairKey(String(st), p))
  );
}

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
    const now = deps.now?.() ?? new Date();

    switch (url.pathname) {
      case "/": {
        const [settings, lastRun, snapshot, history, restocks] = await Promise
          .all([
            getSettings(kv),
            getLastRun(kv),
            getSnapshot(kv),
            listHistory(kv, { now }),
            listRestocks(kv, { now }),
          ]);
        const html = renderPage({
          url,
          tab: parseTab(url.searchParams.get("tab")),
          now,
          settings,
          lastRun,
          snapshot,
          history,
          restocks,
          ntfy,
        });
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            ...BASE_HEADERS,
          },
        });
      }
      case "/api/status": {
        const [settings, lastRun, snapshot] = await Promise.all([
          getSettings(kv),
          getLastRun(kv),
          getSnapshot(kv),
        ]);
        return new Response(JSON.stringify({ settings, lastRun, snapshot }), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...BASE_HEADERS,
          },
        });
      }
    }

    // Remaining routes are POST and take a form body.
    const form = await req.formData().catch(() => null);
    if (!form) return text("Bad form data", 400);
    const back = `tab=${parseTab(String(form.get("return") ?? ""))}`;

    switch (url.pathname) {
      case "/toggle": {
        const storeId = String(form.get("store") ?? "");
        const part = String(form.get("part") ?? "");
        if (findStore(storeId) && ALL_SKUS.some((s) => s.part === part)) {
          await toggleWatch(kv, storeId, part);
        }
        return redirect("tab=stock", findStore(storeId)?.id ?? "");
      }
      case "/settings": {
        const settings = await getSettings(kv);
        const mode = String(form.get("mode") ?? "");
        let watch = settings.watch;
        if (mode === "replace" || mode === "add" || mode === "remove") {
          const pairs = bulkPairs(form);
          if (mode === "replace") watch = pairs;
          else if (mode === "add") watch = [...watch, ...pairs];
          else {
            const drop = new Set(pairs);
            watch = watch.filter((k) => !drop.has(k));
          }
        }
        const enabled = form.has("alerts_form") || form.has("enabled")
          ? form.has("enabled")
          : settings.enabled;
        await saveSettings(kv, sanitizeSettings({ enabled, watch }));
        return redirect("tab=settings&saved=1");
      }
      case "/test-notify": {
        if (!ntfy) {
          return redirect(
            `${back}&error=` +
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
          return redirect(`${back}&tested=1`);
        } catch (e) {
          return redirect(
            `${back}&error=` + encodeURIComponent(
              `Test notification failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ),
          );
        }
      }
      case "/run": {
        if (!deps.runCheck) {
          return redirect(
            `${back}&error=` + encodeURIComponent("Check not available"),
          );
        }
        try {
          await deps.runCheck();
          return redirect(`${back}&ran=1`);
        } catch (e) {
          return redirect(
            `${back}&error=` + encodeURIComponent(
              `Check failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
      }
    }
    return text("Not found", 404);
  };
}
