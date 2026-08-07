# Torn War Call

Read-only faction war intel bot. Polls the Torn API for hospital status on both
your faction and the enemy faction, and pings Discord ~60s before someone's
hospital timer runs out.

## What it does
- Detects your active ranked war automatically (or use a pinned `ENEMY_FACTION_ID`).
- Polls own + enemy faction rosters on an interval.
- Fires a Discord embed when an **enemy** is ~1 min from leaving hospital (call to hit).
- Fires a Discord embed when an **ally** is ~1 min from leaving hospital (heads up to move).
- De-dupes alerts per hospital stay — you get one ping, not one every poll cycle.

## What it deliberately does NOT do
- No auto-attacking. No auto-anything on Torn's side. This only reads data and
  posts to Discord. Wire up attack automation and you're gambling with a ban —
  not my problem to solve, and you shouldn't want it solved.

## Setup
1. `npm install`
2. `cp .env.example .env` and fill in:
   - `TORN_API_KEY` — a Limited or Full Access key works; you only need read access to faction basic/member data.
   - `OWN_FACTION_ID`
   - `DISCORD_WEBHOOK_ENEMY` / `DISCORD_WEBHOOK_ALLY` — Discord channel → Integrations → Webhooks.
   - Optional: `DISCORD_ENEMY_ROLE_ID` to @mention a role like "Hitters".
   - Optional: `DISCORD_ID_MAP` to @mention specific Discord users on ally alerts.
3. `npm start`

## Tuning notes (read this before you complain it "missed" a call)
- `POLL_INTERVAL_MS` is your real accuracy ceiling. A 60s warn window with a
  10s poll interval means your worst-case notice is ~50s, not 60s. Don't set
  this above 15000 during an active war or you'll get sniped by your own lag.
- Torn's API rate limit is per-key. This script makes 2 calls per poll cycle
  (own roster + enemy roster) plus 1 war-status check occasionally. At a 10s
  interval that's ~12-13 calls/min — nowhere near the limit, so don't "optimize"
  this by stretching the interval unless you're running multiple bots on one key.
- Torn tweaks `/v2/*` response shapes sometimes. If members show up as
  `Unknown` state, check the field names against the API Playground
  (torn.com/api.html) and fix `tornApi.js` — the mapping is isolated there
  on purpose so nothing else needs to change.

## Deploying so it actually runs during a war
Run it somewhere that doesn't sleep when your laptop closes: a small VPS,
a Raspberry Pi, or a free-tier box with `pm2` or a systemd service keeping
`npm start` alive. A war-call bot that dies when you tab out is a war-call
bot that gets someone's target un-called mid-chain.
