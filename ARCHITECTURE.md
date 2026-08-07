# Torn War Call - v2.0.0 Architecture Documentation

## Overview

Torn War Call is a Tampermonkey userscript for Torn.com that displays faction war status, hospital timers, and personal travel information. The v2.0.0 refactor introduces a modular, state-driven architecture that separates concerns and enables future expansion.

## Core Principles

1. **Single Source of Truth** — All state flows through the centralized State machine
2. **Separation of Concerns** — Each module handles one responsibility
3. **Event-Driven** — State changes trigger subscribers; no tight coupling
4. **Fail Gracefully** — Errors in one subsystem don't crash the script
5. **Observable** — Debug and History modules track everything

## Module Responsibilities

### Foundation Modules

#### `state.js` — Centralized State Machine
**Responsibility:** Single source of truth for war status.

**States:**
- `UNKNOWN` — Initializing, waiting for data
- `PEACE` — No war scheduled
- `WAR_PREP` — War scheduled but hasn't started
- `ACTIVE_WAR` — War is ongoing
- `WAR_ENDED` — War concluded within 48-hour display window
- `FAILURE` — Script-level error (overrides all other states)

**API:**
```javascript
// Subscribe to state changes (called immediately with current state)
window.TWC.State.subscribe((state, context) => {
  console.log(`War state: ${state}`);
});

// Check current state
const { state, context } = window.TWC.State.get();

// Set state (triggered by other modules)
window.TWC.State.set(window.TWC.State.STATES.ACTIVE_WAR, { war: {...} });
```

#### `debug.js` — Structured Logging
**Responsibility:** Technical logging with severity levels and filtering.

**Severity Levels:**
- `INFO` — Informational events
- `SUCCESS` — Operation succeeded
- `WARNING` — Recoverable issue
- `ERROR` — Error that doesn't crash the script
- `CRITICAL` — Unrecoverable error → triggers `FAILURE` state

**API:**
```javascript
window.TWC.Debug.log(severity, source, message);

// Query logs
const criticals = window.TWC.Debug.query({ severity: 'critical' });
const hospitalLogs = window.TWC.Debug.query({ search: 'hospital' });

// Subscribe to new logs
window.TWC.Debug.onLog((entry) => { /* { time, severity, source, message } */ });
```

#### `history.js` — Event History
**Responsibility:** User-facing event tracking (war detected, ping sent, etc).

**API:**
```javascript
window.TWC.History.record(eventType, message);
const allEvents = window.TWC.History.all();

window.TWC.History.onRecord((entry) => { /* { time, eventType, message } */ });
```

#### `config.js` — Configuration Management
**Responsibility:** Load, validate, save, and export/import settings.

**Persistent Settings:**
- `apiKey` — Torn API key (required)
- `ownFactionId` — Your faction ID (required)
- `enemyFactionId` — Enemy faction ID (optional, auto-detected)
- `panelWidth`, `panelHeight` — UI dimensions
- `panelCollapsed`, `panelHidden` — UI state
- `warnWindowSeconds` — Hospital warning threshold (default: 60)
- `hospitalPollIntervalMs` — Hospital poll interval (default: 12000)
- `warStatusPollIntervalMs` — War status poll interval (default: 30000)

**API:**
```javascript
window.TWC.Config.load();  // Load from GM storage
window.TWC.Config.save(key, value);
const value = window.TWC.Config.get(key);
const allSettings = window.TWC.Config.get();

const errors = window.TWC.Config.validate();  // Check required fields
const exported = window.TWC.Config.exportConfig();  // Get JSON
window.TWC.Config.importConfig(json);  // Restore from JSON
```

#### `travel.js` — Personal Travel Tracking
**Responsibility:** Classify and track the API key owner's travel status.

**Travel Phases:**
- `NONE` — Not traveling
- `DEPARTED` — Flying to destination (has `timeLeft` and `arrivalTs`)
- `ABROAD` — Arrived at destination, awaiting return trip
- `RETURNING` — Flying back to Torn (has `timeLeft` and `arrivalTs`)
- `ARRIVED` — Just landed in Torn (transient)

**API:**
```javascript
window.TWC.Travel.update(rawTravelData, Debug);  // Called with API v2 user travel response
const travel = window.TWC.Travel.get();
window.TWC.Travel.onChange((travel) => { /* react to phase changes */ });
```

### API & Data Modules

#### `api.js` — Torn API Wrapper
**Responsibility:** All Torn API interactions with centralized error handling.

**Key Pattern:** Torn returns HTTP 200 on API errors; error details are in the response body under `error.code` and `error.error`.

**API:**
```javascript
// Fetch faction members
const members = await window.TWC.API.getFactionMembers(factionId, apiKey);
// Returns: [{ id, name, level, state, until }, ...]

// Fetch active ranked war
const war = await window.TWC.API.getActiveRankedWar(factionId, apiKey);
// Returns: { warId, enemyFactionId, enemyFactionName, startTime, endTime } or null

// Fetch current user's travel
const travel = await window.TWC.API.getUserTravel(apiKey);
// Returns: raw travel object from API
```

#### `war-detector.js` — War Status Polling
**Responsibility:** Poll faction war status and drive state machine.

- Periodically calls `API.getActiveRankedWar()`
- Classifies into PEACE → WAR_PREP → ACTIVE_WAR → WAR_ENDED
- Sets State machine accordingly
- Handles consecutive errors with backoff

**API:**
```javascript
window.TWC.WarDetector.start();  // Begin polling
window.TWC.WarDetector.stop();
window.TWC.WarDetector.poll();   // Immediate poll
```

#### `hospital-tracker.js` — Hospital Timer Polling
**Responsibility:** Poll both factions' rosters and emit alerts when members enter warning window.

- De-duplicates alerts per hospital stay (same `until` timestamp doesn't re-fire)
- Clears dedup when member leaves hospital
- Runs both factions in parallel with `Promise.allSettled()`

**API:**
```javascript
window.TWC.HospitalTracker.start();
window.TWC.HospitalTracker.stop();

// Listen for alerts
window.TWC.HospitalTracker.onAlert(({ side, member, secondsLeft }) => {
  // side: 'ally' or 'enemy'
  // member: { id, name, level, state, until }
  // secondsLeft: seconds until they leave hospital
});

// Get current roster data
const allies = window.TWC.HospitalTracker.getMembers('ally');
const enemies = window.TWC.HospitalTracker.getMembers('enemy');
```

### UI Modules

#### `travel-display.js` — Travel Formatting
**Responsibility:** Transform raw travel data into human-readable display format.

**API:**
```javascript
const display = window.TWC.TravelDisplay.getDisplay();
// Returns: {
//   active: boolean,
//   phase: 'departed' | 'abroad' | 'returning' | 'arrived',
//   destination: string,
//   timeRemaining: string (formatted like "1h 23m"),
//   arrivalTime: string (formatted like "14:30"),
//   primaryMessage: string (user-facing),
//   secondaryMessage: string (secondary info)
// }
```

#### `ui-renderer.js` — Main UI
**Responsibility:** Render the panel, handle user interactions, and keep it in sync with state.

**Features:**
- Status header (colored by state)
- Travel display section (dynamic, highlighted when returning)
- Hospital lists (sorted by time, colored warnings)
- Footer with version, debug, settings buttons
- Draggable panel
- Collapsible/hideable

**API:**
```javascript
window.TWC.UIRenderer.initialize();  // Create DOM and listeners
window.TWC.UIRenderer.render();       // Force re-render
window.TWC.UIRenderer.showPanel();
window.TWC.UIRenderer.hidePanel();
```

The UI automatically:
- Re-renders when State changes
- Updates hospital lists every second (smooth countdown)
- Updates travel display every second
- Respects Config.panelHidden and Config.panelCollapsed

### Main Entry Point

#### `torn-war-call-panel.user.js` — Main Userscript
**Responsibility:** Bootstrap all modules and orchestrate lifecycle.

**Initialization Sequence:**
1. Verify all modules are loaded
2. Load Config from storage
3. Validate required settings
4. Initialize UI
5. Start WarDetector (war status polling)
6. Start HospitalTracker (roster polling)
7. Set up Travel polling (every 15s)
8. Subscribe to state changes and hospital alerts for history tracking

**Environment:**
- Must load all module files before main script
- Requires `@grant GM_xmlhttpRequest`, `GM_setValue`, `GM_getValue`
- Works on all Torn.com pages

## Data Flow

```
┌─────────────────┐
│  Config Module  │ — Persistent settings via GM storage
└────────┬────────┘
         │
         ▼
┌──────────────────────────────────────┐
│      War Detector                    │ — API calls to /faction/{id}/wars
├────────────────────────────────────┤
│ · Polls every 30s (configurable)   │
│ · Classifies into war states       │
└────────┬─────────────────────────────┘
         │
         ▼
    ┌─────────────────┐
    │ STATE MACHINE   │ ◄── Single source of truth
    └────────┬────────┘
             │
    ┌────────┴────────┐
    ▼                 ▼
┌─────────┐      ┌──────────────┐
│   UI    │      │  History &   │
│Renderer │      │  Debug logs  │
└────┬────┘      └──────────────┘
     │
     ▼ (observes State changes)
   Panel renders with current state

Hospital Tracker ─────┐
(parallel polling)    │
                      ├─► onAlert() ──► History.record("ping", ...)
                      │
                      └─► UIRenderer.updateHospitalList()

Travel Polling ──► Travel.update() ──► TravelDisplay.getDisplay() ──► UI renders
```

## Module Loading

Modules must load in dependency order. When using as a Tampermonkey script:

**Option 1: Combined File** (current setup)
- Concatenate all modules into one file
- Load order is guaranteed
- Simpler for distribution

**Option 2: Via @require** (for development)
```javascript
// @require https://path/to/modules/state.js
// @require https://path/to/modules/debug.js
// @require https://path/to/modules/history.js
// @require https://path/to/modules/travel.js
// @require https://path/to/modules/config.js
// @require https://path/to/modules/api.js
// @require https://path/to/modules/travel-display.js
// @require https://path/to/modules/war-detector.js
// @require https://path/to/modules/hospital-tracker.js
// @require https://path/to/modules/ui-renderer.js
// @require https://path/to/modules/loader.js
```

## Error Handling & Recovery

**Recoverable Errors** (logged as ERROR, don't crash)
- Network timeouts
- API rate limiting
- Single faction poll failure (other runs in parallel)
- Missing optional fields in API responses

**Unrecoverable Errors** (logged as CRITICAL, trigger FAILURE state)
- Missing required config fields at initialization
- Config validation fails
- All modules fail to load

When a CRITICAL error occurs:
1. State becomes FAILURE
2. UI displays "Script Failure" header with color
3. All background workers are still attempted to run
4. User can access Debug panel to diagnose

## Performance Considerations

**Polling Intervals**
- War detection: 30s (configurable, set higher if bandwidth-constrained)
- Hospital tracking: 12s (configurable)
- Travel: 15s (not configurable, reasonable compromise)
- UI tick (render countdown): 1s

**DOM Optimization**
- Styles created once in `<head>` (reusable class names)
- Hospital lists re-rendered only on data change
- Panel only updates when not hidden
- Dragging doesn't trigger render

**Storage**
- Only required settings cached in GM storage
- History and Debug logs kept in memory (max 300 and 150 entries)
- Config import/export available for manual backups

## Future Enhancements

### Phase 2 (Recommended)
1. Resizable panel with saved dimensions
2. Settings panel (currently placeholder)
3. Debug panel with log filtering and search
4. Faction page detection (hide UI when off-faction)
5. Ping configuration panel

### Phase 3
1. Health monitor (check war detection, storage, timers)
2. Auto-recovery mechanisms
3. Dark/light theme detection
4. Notification customization

### Phase 4
1. Browser notifications and sound alerts
2. Discord webhook integration (send pings to Discord)
3. Custom war state messages (win/loss messages)
4. Role-based access (settings per faction rank)

## Testing & Debugging

### Enable Console Logging
All modules log to browser console with `[TWC:moduleName]` prefix. Open DevTools (F12) and filter by "TWC".

### Access Debug Data
```javascript
// Get all logs
window.TWC.Debug.query();

// Filter by severity
window.TWC.Debug.query({ severity: 'error' });

// Search
window.TWC.Debug.query({ search: 'hospital' });

// Get history
window.TWC.History.all();

// Check current state
window.TWC.State.get();

// Check current travel
window.TWC.Travel.get();

// Check settings
window.TWC.Config.get();
```

### Common Issues

**"Missing required modules"** — Some modules didn't load. Check browser console for errors.

**"Invalid type for X"** — Config validation failed. Run `window.TWC.Config.get()` to see stored values.

**API Key not working** — Verify key has faction read access. Test with:
```javascript
window.TWC.API.getFactionMembers(123456, 'your_key_here');
```

**No hospital members showing** — Check that both factions have API access and members with the right status. Run:
```javascript
window.TWC.HospitalTracker.getMembers('ally');
```

## Contributing

When adding features:
1. Keep modules focused and single-purpose
2. Use State machine for state changes
3. Use Debug.log() for diagnostics
4. Use History.record() for user-visible events
5. Use Config for persistent settings
6. Listen to State.subscribe() rather than polling
7. Return promises for async operations
8. Handle errors gracefully (never throw in event listeners)

When modifying existing modules:
1. Don't break the subscription/listener pattern
2. Maintain backward compatibility with stored settings
3. Update this documentation
4. Test with both ally and enemy factions visible (or missing)
