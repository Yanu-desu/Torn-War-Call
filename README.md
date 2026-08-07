# Torn War Call

A modular Tampermonkey userscript for Torn.com that displays faction war status, hospital timers, and personal travel information. Designed for coordination during faction wars.

## What It Does

- **War State Tracking** — Detects active ranked wars and displays status (Peace, Prep, Active, Ended)
- **Hospital Timers** — Shows ally and enemy faction members in hospital, sorted by time remaining
- **Travel Tracking** — Displays your personal travel status including ETA and time remaining
- **Smart Alerts** — Notifies when faction members are within 60 seconds of leaving hospital
- **Persistent Storage** — Remembers settings between sessions
- **Debug System** — Tracks events and logs for troubleshooting

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or similar userscript manager
2. Copy the script code from `tampermonkey/torn-war-call-panel.user.js` into a new Tampermonkey script
3. Save and enable the script
4. Visit Torn.com and provide:
   - **Torn API Key** (get from Torn.com Settings → API)
   - **Your Faction ID**
   - **Enemy Faction ID** (optional — auto-detected during active wars)

## Architecture

v2.0.0 introduces a modular, state-driven architecture. See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation on:
- Module responsibilities
- State machine
- Data flow
- Error handling
- Future enhancements

**Module Overview:**
- `state.js` — Centralized war status state machine
- `debug.js` — Structured logging system
- `history.js` — User event tracking
- `travel.js` — Personal travel classification
- `config.js` — Settings management
- `api.js` — Torn API wrapper
- `war-detector.js` — War status polling
- `hospital-tracker.js` — Roster and hospital polling
- `travel-display.js` — Travel formatting for UI
- `ui-renderer.js` — Main UI panel

## Configuration

Settings are stored in browser storage and configured via the UI (Settings button). Advanced users can configure directly:

```javascript
// In browser console while on Torn.com
window.TWC.Config.save('warnWindowSeconds', 45);  // Alert threshold
window.TWC.Config.save('hospitalPollIntervalMs', 10000);  // Poll frequency
window.TWC.Config.get();  // View all settings
```

## Keyboard Shortcuts & Controls

- **Drag header** — Move panel
- **Toggle arrow** — Collapse/expand panel
- **⚙ button** — Settings (v2.1+)
- **🔧 button** — Debug panel (v2.1+)
- **✕ button** — Hide panel (click again to restore)

## Troubleshooting

### "Missing required modules"
One or more modules failed to load. Check:
- All module files are present
- Load order is correct (state → debug → history → travel → config → api → war-detector → hospital-tracker → travel-display → ui-renderer)
- No browser extensions are blocking the script

### "API key not working"
- Verify key has **faction read access** (Settings → API → Selections)
- Test the key manually in [Torn API Playground](https://www.torn.com/api.html)

### Hospital timers not updating
- Check that API key has **faction member** read access
- Verify both factions are accessible (may require VPN if accessing certain factions)
- Run `window.TWC.HospitalTracker.poll()` to force an update

### Travel not showing
- Personal travel only works if your API key is a **user key** (full account access)
- Faction-scoped keys cannot access personal travel data

## Browser Compatibility

Tested on:
- Chrome/Chromium (latest)
- Firefox (latest)
- Edge (latest)

Requires Tampermonkey or equivalent userscript manager.

## Upgrading from v1.0.0

v2.0.0 is a major rewrite with **breaking changes**:
- Settings key prefix changed (`twc_` → more specific keys)
- Panel layout redesigned with status header
- Module structure completely different

**Migration:**
1. Uninstall v1.0.0 from Tampermonkey
2. Install v2.0.0
3. Re-enter your API key and faction IDs in the Settings panel
4. Old settings will not transfer; this is intentional for a clean slate

## Performance

- War detection polls every **30 seconds** (configurable)
- Hospital tracking polls every **12 seconds** (configurable)
- Travel updates every **15 seconds**
- UI countdown updates every **second**

Designed to be lightweight — minimal impact on browsing experience.

## Future Roadmap

**Planned for v2.1:**
- Dedicated Settings panel
- Debug panel with log filtering
- Health monitor (system diagnostics)
- Faction page detection (auto-hide outside faction)

**Planned for v2.2:**
- Resizable/collapsible panel
- Browser notifications
- Custom ping configuration (up to 3 slots)
- Config import/export

**Planned for v2.3+:**
- Sound alerts
- Discord webhook integration
- Dark/light theme detection
- Role-based settings

## Known Limitations

- **No Discord integration yet** — See [Discord bot](../src/) for server-side option
- **Single key only** — Cannot track multiple faction members' personal travel
- **War end detection** — Relies on API `end` timestamp (may lag slightly)
- **Mobile not supported** — Designed for desktop browser

## Development

See [ARCHITECTURE.md](./ARCHITECTURE.md) for contributing guidelines and testing instructions.

### Running Locally

All modules are in `/modules/`, main script is in `/tampermonkey/`.

To test:
1. Use Tampermonkey's "Create userscript from URL" to load local files
2. Or manually copy/paste code into Tampermonkey
3. Use browser console (`F12`) to access debug API

## License

See [LICENSE](./LICENSE) file.

## Support

For issues, suggestions, or feature requests, check the GitHub issues or contact the development team.
