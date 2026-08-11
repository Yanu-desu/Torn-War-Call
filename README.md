# Torn War Call

If you like this, consider giving me a [![Ko-fi](https://img.shields.io/badge/-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white)]([https://ko-fi.com/YOUR_KOFI_USERNAME](https://ko-fi.com/yanuuu))

A browser panel for Torn faction wars. It watches hospital timers for your
faction and the enemy faction, tracks your own travel status, and can ping
a Discord channel a set number of seconds before someone lands.

It only reads data — it never attacks, clicks, or does anything on your
behalf. Safe to leave running.

## Install

1. Get the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Go to [ Greasy Fork ](https://greasyfork.org/en) and search [Torn War Call](https://greasyfork.org/en/scripts/590344-torn-war-call).
3. Go to your faction page on torn.com. The panel appears top-right.

## First-time setup

Click the **gear icon** on the panel. You need three things:

| Field | Where to find it |
|---|---|
| Torn API key | torn.com → Settings → API Keys → create a **Limited Access** key |
| Own Faction ID | The number in your faction's URL: `factions.php?...&ID=12345` |
| Discord Webhook (ally + enemy) | Discord channel → Settings → Integrations → Webhooks |

Faction ID is required. The API key is required. Webhooks are optional —
without them you still get the full in-panel display, just no Discord pings.

Hit Save. The panel should show a status like "At Peace" within a few
seconds. If it doesn't, click the **wrench icon** for the debug panel —
it'll tell you exactly what's wrong.

## About the API
The API only **READS** you, your faction member and enemy hospital time, travel time and if anyone is abroad. I **DO NOT** collect or **STORE** your data as it is stored within your hardware and you have the absolute freedom with it.


## What each icon does

- ⚙ **Gear** — your API key, faction ID, and Discord webhooks
- 🔔 **Bell** — ping settings: up to 3 alert thresholds per side (e.g. "warn
  me at 60 seconds, then again at 10 seconds")
- 🔧 **Wrench** — debug panel: live log, event history, and a health check
  that tells you what's working and what isn't

## The panel itself

- **Enemy / Ally** sections list anyone hospitalized, traveling, or abroad.
  Rows glow when someone's close to leaving hospital.
- Click a section title to collapse it.
- Drag the header to move the panel. Drag the bottom-right corner to resize.
- Collapse to a small tab, or hide it completely (bring it back from the
  Tampermonkey menu, or the small eye tab int the bottom right corner that stays visible).
- The panel only shows up on faction pages — it gets out of your way
  everywhere else on Torn.

## Backing up your settings

Settings → **Export Config** downloads a JSON file with everything (API
key, webhooks, ping settings). **This file contains your key and webhook
URLs in plain text — don't share it.** Import it back the same way on
another browser or after a reinstall.

## Troubleshooting

Open the wrench icon → **Health** tab first. It checks your API key,
faction ID, both webhooks, the polling timer, and more, with a plain-English
reason next to anything that's failing. That's almost always faster than
guessing.
