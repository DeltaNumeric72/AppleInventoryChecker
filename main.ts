// Entry point for Deno Deploy: schedules the stock check every minute and
// serves the password-protected settings page.

import { runCheck } from "./src/checker.ts";
import type { RunStatus } from "./src/settings.ts";
import { createHandler } from "./src/web.ts";

const kv = await Deno.openKv();

// Guard against a manual "Run check now" overlapping a scheduled run.
let inFlight: Promise<RunStatus> | null = null;
function runOnce(): Promise<RunStatus> {
  inFlight ??= runCheck(kv).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

Deno.cron("iphone-duo-stock-check", "* * * * *", async () => {
  await runOnce();
});

Deno.serve(createHandler(kv, { runCheck: runOnce }));
