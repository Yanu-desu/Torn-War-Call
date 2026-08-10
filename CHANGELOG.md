# Changelog

##v6.0.0 (2026-08-08, late evening)
Feature-complete. Every planned feature is in: state machine, war
detection, hospital + travel tracking, resizable/collapsible UI, ping
system with per-side Discord delivery, notification history, health
monitor, config import/export, and automatic error recovery.

No further features planned. Future entries below this point are bugfixes
only unless something new gets specifically requested from the users of this script.

---

## 2026-08-08

**Rebuilt from Scratch (v3.0.0 → v3.5.0)**
- New architecture: centralized state machine (Unknown / Peace / War
  Prep / Active War / War Ended / Script Failure), with every other part
  of the script reacting to state changes instead of checking war status
  independently.
- War detection switched to the v2 Torn API after the v1 endpoint started
  returning "only available in API v2" errors.
- Settings panel added — API key, faction ID, Discord webhook, all
  editable from the panel itself, nothing hardcoded.
- Travel tracking added: shows direction (Torn → destination or the
  reverse) and a live countdown, confirmed against a real API response.
- Countdown display reworked into hr/min/sec with proper pluralization.

**UI overhaul (v3.1.0 → v4.1.1)**
- Full visual redesign — dark theme with cyan/magenta accents.
- Panel became resizable, collapsible, and fully hideable (with a small
  reopen tab and a Tampermonkey menu command).
- Panel now only shows on faction pages, and gets out of the way — with
  a real fix after a bug briefly stopped Discord alerts from firing while
  the panel was off-screen.
- Fixed a rate-limit issue (Torn API error 5) by adding exponential
  backoff so a temporary block doesn't turn into a sustained one.
- Traveling/abroad members merged directly into the Enemy/Ally lists
  instead of a separate section.
- Enemy/Ally sections made independently collapsible.

**Ping System and More (v4.0.0 → v6.0.0)**
- Ping system rebuilt: up to 3 configurable alert thresholds per side
  (ally/enemy), each with its own message, its own Discord webhook, and
  independent enable/disable.
- Debug panel expanded into three tabs — Log, History, and Health, the
  last one running live pass/fail checks on every subsystem.
- Config import/export added (JSON backup/restore).
- Error recovery: the script now auto-recovers from a failure state once
  polling succeeds again, instead of staying stuck until a manual restart.
- Performance pass: DOM elements are cached instead of re-queried every
  second, and the countdown tick skips rendering entirely when nothing
  is actually counting down.

---

## Earlier history
The project started as a simple Node.js background bot (hospital alerts
only), then moved to a browser-based Tampermonkey panel for live in-page
viewing. Both were fully replaced by the architecture above.