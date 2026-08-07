# Torn War Call — Copilot Instructions

Modular Tampermonkey userscript for Torn.com faction war coordination. Displays hospital timers, war state, and personal travel information with a collapsible in-page panel.

## Installation & Configuration

**Setup:**
1. Copy `tampermonkey/torn-war-call-panel.user.js` into Tampermonkey
2. Visit Torn.com, click the Settings button in the panel
3. Provide:
   - `Torn API Key` — User or faction key with read access
   - `Own Faction ID` — Your faction
   - `Enemy Faction ID` (optional, auto-detected during active wars)

**No build step** — Pure userscript, runs directly in browser.

## Architecture Overview

The v2.0.0 refactor uses a **modular, state-driven architecture**. For complete documentation, see [ARCHITECTURE.md](./ARCHITECTURE.md).

### Module Structure

**Foundation (data & state):**
- `state.js` — Centralized war status state machine (UNKNOWN → PEACE → WAR_PREP → ACTIVE_WAR → WAR_ENDED → FAILURE)
- `debug.js` — Structured logging with severity levels (INFO, SUCCESS, WARNING, ERROR, CRITICAL)
- `history.js` — User event tracking (war detected, ping sent, settings changed)

**Configuration & API:**
- `config.js` — Persistent settings manager with validation and export/import
- `api.js` — Torn API wrapper handling the HTTP 200 error quirk
- `travel.js` — Personal travel classifier (NONE → DEPARTED → ABROAD → RETURNING → ARRIVED)

**Business Logic (polling & detection):**
- `war-detector.js` — Polls `/faction/{id}/wars`, drives state transitions
- `hospital-tracker.js` — Polls rosters, de-duplicates alerts per hospital stay
- `travel-display.js` — Formats travel data for UI consumption

**UI:**
- `ui-renderer.js` — Main panel rendering, event handling, state subscriptions
- `torn-war-call-panel.user.js` — Bootstrap and orchestration

### Data Flow

```
Config + API ──────────────────┐
                               │
                    ┌──────────▼─────────┐
                    │  War Detector      │
                    │  (polls every 30s) │
                    └──────────┬─────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  STATE MACHINE       │ ◄── Single source of truth
                    │  (UNKNOWN/PEACE/...) │
                    └──────────┬───────────┘
                               │
                    ┌──────────┴────────────┐
                    │                       │
                    ▼                       ▼
            ┌──────────────────┐   ┌─────────────────┐
            │  UI Renderer     │   │ History & Debug │
            │  (subscribes)    │   │ (logs events)   │
            └────────┬─────────┘   └─────────────────┘
                     │
                     ▼
            Panel displays with
            status header, hospital
            lists, travel info

Hospital Tracker ─(polls every 12s)─┐
                                     ├──► onAlert() ──► History + UI
                                     │
                                     └──► getMembers() ──► UI renders lists

Travel Polling ──(every 15s)──► Travel.update() ──► TravelDisplay.getDisplay() ──► UI
```

## Key Conventions

1. **Logging** — Use `DEBUG.log(severity, source, message)`. All modules log with `[TWC:source]` console prefix.
2. **State-Driven** — Everything reacts to `STATE.subscribe()`, not polling. Never duplicate state checks.
3. **Async Patterns** — All API calls return promises; handle errors gracefully.
4. **De-duplication** — Hospital alerts use `(userId, until)` pairs; clears when member leaves.
5. **Storage** — Only settings use GM storage; events/logs stay in memory (max 300/150 entries).
6. **Error Recovery** — Single subsystem errors logged as ERROR; only CRITICAL errors crash (→ FAILURE state).

## Running & Testing

**No tests configured.** Debug via:

```javascript
// Access from browser console (F12)
window.TWC.State.get();                      // Current war state
window.TWC.Debug.query({ severity: 'error' });  // Recent errors
window.TWC.History.all();                    // User events
window.TWC.Config.get();                     // Current settings
window.TWC.HospitalTracker.poll();           // Force roster update
```

## Common Modifications

**Change alert threshold:**
```javascript
window.TWC.Config.save('warnWindowSeconds', 45);  // 45 seconds instead of 60
```

**Increase war detection frequency (during active war):**
```javascript
window.TWC.Config.save('warStatusPollIntervalMs', 15000);  // Every 15s
```

**Export settings for backup:**
```javascript
const backup = window.TWC.Config.exportConfig();
console.log(JSON.stringify(backup, null, 2));
```

**Check API access:**
```javascript
const key = window.TWC.Config.get('apiKey');
const factionId = window.TWC.Config.get('ownFactionId');
window.TWC.API.getFactionMembers(factionId, key).then(console.log).catch(console.error);
```

## Important Implementation Details

### API Quirk
Torn returns HTTP 200 even on logical errors. The `error` field is always in the response body. `api.js` checks for this and rejects the promise. All callers should `.catch()` for recovery.

### War State Classification
- **PEACE** — No ranked war object OR war has ended (within 48-hour display window)
- **WAR_PREP** — Ranked war exists, `startTime` in future
- **ACTIVE_WAR** — War has started, not ended
- **WAR_ENDED** — War ended, display within 48 hours
- **UNKNOWN** → **FAILURE** — Initialization error (config missing, all modules failed to load)

### Travel Phases
- **DEPARTED** → Has `destination != 'Torn'`, `timeLeft > 0` (flying out)
- **ABROAD** → `timeLeft = 0` AND `destination != 'Torn'` (landed)
- **RETURNING** → `destination == 'Torn'`, `timeLeft > 0` (flying back)
- **ARRIVED** → `destination == 'Torn'`, `timeLeft = 0` (transient; cleared on next poll)

### Hospital De-duplication
- When someone enters hospital, track `(userId, until)` in `notifiedAlly` or `notifiedEnemy` Map
- Only alert once per unique `until` timestamp
- Clear entry when `state !== 'Hospital'` or `until <= now`
- This prevents the same hospital stay triggering multiple alerts

## File Organization

```
modules/
  state.js              — State machine
  debug.js              — Logging
  history.js            — Event tracking
  travel.js             — Travel classification
  config.js             — Settings
  api.js                — API wrapper
  war-detector.js       — War polling
  hospital-tracker.js   — Roster polling
  travel-display.js     — Travel formatting
  ui-renderer.js        — Main UI
  loader.js             — Load order documentation

tampermonkey/
  torn-war-call-panel.user.js   — Main userscript (orchestration)

ARCHITECTURE.md           — Detailed module docs
README.md                 — User-facing guide
.github/copilot-instructions.md  — This file
```

## Performance Notes

- **DOM** — Styles created once; lists re-rendered only on data change
- **Polling** — War (30s), Hospitals (12s), Travel (15s), UI tick (1s)
- **Memory** — Debug/History capped at 300/150 entries
- **Storage** — Only settings persisted; logs in-memory

Designed to be lightweight. Minimal CPU/bandwidth impact.

## Future Enhancements

**Phase 2** (in-progress):
- Settings UI panel
- Debug log filtering and search
- Faction page detection (hide when off faction pages)

**Phase 3**:
- Health monitor (system diagnostics)
- Resizable panels

**Phase 4**:
- Browser notifications
- Sound alerts
- Discord integration

## Module Dependencies

**Load order matters.** Each module depends on foundation modules:
1. `state.js` (no deps)
2. `debug.js` (no deps)
3. `history.js` (no deps)
4. `travel.js` (no deps)
5. `config.js` (no deps)
6. `api.js` (depends on config)
7. `travel-display.js` (depends on travel)
8. `war-detector.js` (depends on api, state, debug, config)
9. `hospital-tracker.js` (depends on api, debug, config)
10. `ui-renderer.js` (depends on state, config, debug, travel-display, hospital-tracker)
11. `torn-war-call-panel.user.js` (depends on all above)

All modules store themselves in `window.TWC` namespace to avoid conflicts.

## Troubleshooting

**"Missing required modules"** — Check load order in browser console.

**State stuck on UNKNOWN** — Check Config validation: `window.TWC.Config.validate()`.

**No hospital members showing** — Run `window.TWC.HospitalTracker.poll()` and check console for errors.

**Travel not updating** — Requires user-level API key (full account access), not faction-scoped key.

