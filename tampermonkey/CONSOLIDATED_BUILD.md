# Consolidated Userscript Build

## What Is This?

This is a **single-file, production-ready version** of Torn War Call v2.0.0 that bundles all 10 modules into one userscript. 

**Problem Solved:** The original modular architecture required all modules to be loaded separately. This consolidated version eliminates that dependency by bundling everything into a single file with guaranteed load order.

## Files

- `torn-war-call-panel.user.js` — The consolidated, production-ready userscript (1333 lines, 39 KB)
- `torn-war-call-panel-consolidated.user.js` — Identical copy (for reference/backup)
- `torn-war-call-panel.user.js.backup` — Original modular version (for rollback if needed)

## Installation

1. **Copy the entire code** from `torn-war-call-panel.user.js`
2. **Open Tampermonkey Dashboard** (click Tampermonkey icon → Dashboard)
3. **Find "Torn War Call Panel"** in your scripts list
4. **Click Edit** to open the script editor
5. **Select all code** (Ctrl+A)
6. **Paste the new code** (Ctrl+V)
7. **Save the script** (Ctrl+S or File → Save)
8. **Reload Torn.com** — The panel should appear!

## Modules Included (In Load Order)

1. **state.js** — Centralized war state machine
2. **debug.js** — Structured logging system
3. **history.js** — User event tracking
4. **travel.js** — Personal travel classification
5. **config.js** — Settings management
6. **api.js** — Torn API wrapper
7. **travel-display.js** — Travel formatting
8. **war-detector.js** — War status polling
9. **hospital-tracker.js** — Roster polling
10. **ui-renderer.js** — Main UI panel

Plus initialization logic that orchestrates all modules.

## What This Solves

**Error before:**
```
[TWC] Missing required modules: Config, State, Debug, Travel, ...
```

**Why it happened:**
- Tampermonkey was loading only the main script
- All 10+ modules need to be loaded in specific order
- The main script checked for them and failed

**Solution:**
- All modules are now embedded in a single file
- Load order is guaranteed
- No external dependencies
- Works immediately when pasted into Tampermonkey

## Features

All v2.0.0 features work out of the box:

- War state tracking (UNKNOWN → PEACE → WAR_PREP → ACTIVE_WAR → WAR_ENDED → FAILURE)
- Hospital timer alerts with de-duplication
- Personal travel tracking with ETA
- Dynamic countdown updates
- Drag-to-move panel
- Collapsible/hideable UI
- Debug logging
- Event history
- Error recovery
- Configuration persistence

## Size

- **1,333 lines of code**
- **38,944 bytes** (fully self-contained)
- **No external dependencies** (uses only GM_* APIs)

## Reverting to Modular Version

If you want to use the original modular architecture with separate `@require` statements:

1. Restore `torn-war-call-panel.user.js.backup`
2. Add `@require` directives for each module in correct order
3. Ensure all module files are accessible

(See ARCHITECTURE.md for details)

## Development vs Production

- **Development:** Use modular version with separate files (easier to edit individual modules)
- **Production:** Use consolidated version (easier installation, no dependencies)

This consolidated version is recommended for end users. Developers should work with the modular version and regenerate the consolidated build when making changes.

## Troubleshooting

### "Script failed to load"
- Check browser console (F12) for [TWC] error messages
- Verify all text was copied (should be 1,333 lines)
- Verify file ends with the closing `})();`

### "Panel still not appearing"
- Clear Tampermonkey cache: Dashboard → Storage → Clear all
- Refresh Torn.com (Ctrl+F5)
- Verify script is enabled (green checkmark)

### "Config errors (missing API key, faction ID)"
- Open DevTools (F12)
- Run: `window.TWC.Config.validate()`
- Click the Settings button in the panel to configure

## See Also

- **ARCHITECTURE.md** — Full module documentation (if using modular version)
- **MIGRATION.md** — Upgrade guide from v1.0.0
- **README.md** — User guide and features
- **REFACTORING_SUMMARY.md** — Design decisions and roadmap
