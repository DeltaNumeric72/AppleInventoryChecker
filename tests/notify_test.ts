import {
  formatHitsMessage,
  ntfyConfigFromEnv,
  sendNtfy,
} from "../src/notify.ts";
import type { Hit } from "../src/settings.ts";
import { assert, assertEquals, assertRejects } from "./_assert.ts";

const hit = (storeId: string, storeName: string, part: string): Hit => ({
  storeId,
  storeName,
  part,
});

Deno.test("formatHitsMessage: groups by SKU then stores", () => {
  const { title, body } = formatHitsMessage([
    hit("R350", "Square One", "MK2C4VC/A"),
    hit("R121", "Eaton Centre", "MK294VC/A"),
    hit("R350", "Square One", "MK294VC/A"),
    hit("R120", "Yorkdale", "MK294VC/A"),
  ]);
  assertEquals(title, "iPhone Duo in stock at 3 GTA stores");
  assertEquals(
    body,
    "iPhone Duo 1TB Night Sky: Eaton Centre, Square One, Yorkdale\niPhone Duo 2TB Night Sky: Square One",
  );
});

Deno.test("formatHitsMessage: singular title and unknown part fallback", () => {
  const { title, body } = formatHitsMessage([
    hit("R121", "Eaton Centre", "XYZ"),
  ]);
  assertEquals(title, "iPhone Duo in stock at 1 GTA store");
  assertEquals(body, "XYZ: Eaton Centre");
});

Deno.test("ntfyConfigFromEnv: null without topic, defaults server", () => {
  const keys = ["NTFY_TOPIC", "NTFY_SERVER", "NTFY_TOKEN"];
  const saved = keys.map((k) => Deno.env.get(k));
  try {
    keys.forEach((k) => Deno.env.delete(k));
    assertEquals(ntfyConfigFromEnv(), null);
    Deno.env.set("NTFY_TOPIC", "duo");
    assertEquals(ntfyConfigFromEnv(), {
      server: "https://ntfy.sh",
      topic: "duo",
      token: undefined,
    });
    Deno.env.set("NTFY_SERVER", "https://ntfy.example.com");
    Deno.env.set("NTFY_TOKEN", "tk_1");
    assertEquals(ntfyConfigFromEnv(), {
      server: "https://ntfy.example.com",
      topic: "duo",
      token: "tk_1",
    });
  } finally {
    keys.forEach((k, i) =>
      saved[i] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[i]!)
    );
  }
});

Deno.test("sendNtfy: JSON publish with auth header", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const fetchFn: typeof fetch = (url, init) => {
    seen = { url: String(url), init };
    return Promise.resolve(new Response("{}"));
  };
  await sendNtfy(
    { server: "https://ntfy.sh/", topic: "duo", token: "tk" },
    {
      title: "Ünïcode ✓",
      body: "b",
      priority: 5,
      tags: ["iphone"],
      click: "https://x",
    },
    fetchFn,
  );
  assertEquals(seen!.url, "https://ntfy.sh/");
  assertEquals(seen!.init!.method, "POST");
  assertEquals(
    (seen!.init!.headers as Record<string, string>)["Authorization"],
    "Bearer tk",
  );
  assertEquals(JSON.parse(seen!.init!.body as string), {
    topic: "duo",
    title: "Ünïcode ✓",
    message: "b",
    priority: 5,
    tags: ["iphone"],
    click: "https://x",
  });
});

Deno.test("sendNtfy: no auth header without token; non-2xx throws", async () => {
  let headers: Record<string, string> = {};
  await sendNtfy({ server: "https://ntfy.sh", topic: "t" }, {
    title: "a",
    body: "b",
  }, (_u, init) => {
    headers = init!.headers as Record<string, string>;
    return Promise.resolve(new Response("{}"));
  });
  assert(!("Authorization" in headers));
  await assertRejects(() =>
    sendNtfy({ server: "https://ntfy.sh", topic: "t" }, {
      title: "a",
      body: "b",
    }, () => Promise.resolve(new Response("denied", { status: 403 })))
  );
});
