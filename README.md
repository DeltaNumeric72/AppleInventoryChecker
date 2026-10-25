# iPhone Duo GTA Stock Watcher

A [Deno Deploy](https://deno.com/deploy) app that checks Apple Store pickup
availability for the **iPhone Duo** at Greater Toronto Area stores **every
minute** and sends a push notification through [ntfy](https://ntfy.sh) whenever
a model you've selected is in stock.

Based on the approach used by
[worthbak/apple-store-inventory-checker](https://github.com/worthbak/apple-store-inventory-checker)
and
[worthbak/inventory-checker-app](https://github.com/worthbak/inventory-checker-app)
(Apple's `shop/retail/pickup-message` endpoint, Canadian part numbers from the
app's `iPhone-Duo-intl.json` catalog).

## What it watches

| Storage | Star White | Night Sky |
| ------- | ---------- | --------- |
| 256GB   | MK244VC/A  | MK254VC/A |
| 512GB   | MK264VC/A  | MK274VC/A |
| 1TB     | MK284VC/A  | MK294VC/A |
| 2TB     | MK2A4VC/A  | MK2C4VC/A |

Stores: Eaton Centre (R121), Yorkdale (R120), Sherway Gardens (R208), Fairview
(R333), Square One (R350), Markville (R515), Mapleview Centre (R447), Upper
Canada Mall (R429), Conestoga (R464).

All models and stores are selected by default. Change them on the settings page;
your choices are stored in Deno KV.

## How it behaves

- Runs every minute via `Deno.cron`. Each run makes one request anchored at the
  first selected store (with nearby stores included), plus one follow-up request
  for each selected store that wasn't in the first response, such as Conestoga.
- While anything you've selected is available, you get **one push per minute**
  summarising every store/model hit. Tapping it opens the Apple Store page.
- After 10 failures in a row (e.g. Apple's bot detection, HTTP 541), you get a
  single warning push. The counter resets on the next success.

## Setup

1. **Phone:** install the ntfy app (iOS/Android) and subscribe to a topic with a
   long, hard-to-guess name, e.g. `duo-gta-7f3k9q2x`. Anyone who knows the topic
   name can read it, so treat it like a password.
2. **Deno Deploy:** create a new project from this GitHub repo with entrypoint
   `main.ts`.
3. **Environment variables** (project settings):

   | Variable         | Required | Purpose                                          |
   | ---------------- | -------- | ------------------------------------------------ |
   | `NTFY_TOPIC`     | yes      | Your ntfy topic name                             |
   | `ADMIN_PASSWORD` | yes      | Password for the settings page (any username)    |
   | `NTFY_SERVER`    | no       | Self-hosted ntfy URL (default `https://ntfy.sh`) |
   | `NTFY_TOKEN`     | no       | Access token if your ntfy topic is protected     |

4. Open the deployment URL, log in, pick your models/stores, and press **Send
   test notification** to confirm the push arrives. The cron job shows up under
   the project's **Cron** tab.

## Local development

```sh
NTFY_TOPIC=your-topic ADMIN_PASSWORD=secret deno task dev   # http://localhost:8000
deno task test
deno task check
```

## Endpoints

- `GET /`: settings and status page (Basic auth)
- `POST /settings`, `POST /test-notify`, `POST /run`: form actions (Basic auth)
- `GET /api/status`: JSON settings plus the last run (Basic auth)
- `GET /health`: public liveness check

## Caveats

- Apple's endpoint is unofficial and may change or rate-limit. Polling every
  minute from a Deno Deploy IP could trigger bot detection (HTTP 541). The app
  retries twice per request and warns you if it keeps failing.
- Part numbers come from a scraped catalog (October 2026). If Apple changes
  them, update `src/catalog.ts`.
