# Torn War Call

See [CHANGELOG.md](./CHANGELOG.md) for version history.

Read-only faction war intel bot. Polls the Torn API for hospital status on both
your faction and the enemy faction, and pings Discord ~60s before someone's
hospital timer runs out.

## What it does

* Detects your active ranked war automatically (or use a pinned `ENEMY_FACTION_ID`).
* Polls own + enemy faction rosters on an interval.
* Fires a Discord embed when an **enemy** is ~1 min from leaving hospital (call to hit).
* Fires a Discord embed when an **ally** is ~1 min from leaving hospital (heads up to move).
* De-dupes alerts per hospital stay — you get one ping, not one every poll cycle.

## What it deliberately does NOT do

* No auto-attacking. No auto-anything on Torn's side. This only reads data and
  posts to Discord. Wire up attack automation and you're gambling with a ban —
  not my problem to solve, and you shouldn't want it solved.

## Installation

1. Install Tampermonkey.
2. Go to the Control Panel.
3. Add the script from [Greasy Fork](https://greasyfork.org/en/scripts/590344-torn-war-call-panel).
4. Go to Torn and reload.

## Development Notes

* The travel feature will **not be implemented for now** and has been rolled back.
  I currently don't have enough knowledge to implement it properly, so it will
  remain on hold until help or better ideas are available.
* Sorry for the UI clutter from the previous travel implementation. The feature has
  been rolled back for now while the implementation is being reworked.
* Customizable UI, text, and additional quality-of-life features will be added
  soon.

## License

See the [LICENSE](./LICENSE) file for licensing information.

### Forum Launch Post soon
