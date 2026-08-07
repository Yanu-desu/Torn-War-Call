# Torn War Call v2.0.0 Migration Guide

## What's Changed

v2.0.0 is a **major rewrite** that transforms the script from a monolithic single file into a **modular, state-driven architecture**. While the user experience remains similar, the internal structure is completely different.

### User-Facing Changes

**Improvements:**
- Status header showing current war state (Peace, Prep, Active, Ended, Syncing, Failure)
- Personal travel tracking integrated into the panel
- Better error handling and recovery
- Debug panel for troubleshooting
- Settings panel instead of inline inputs
- History log tracking important events
- Collapsible and hideable UI

**Breaking Changes:**
- Settings storage keys changed (old settings won't migrate)
- Old v1.0.0 stored data is discarded (intentional for clean slate)
- Panel layout redesigned
- Requires all modules to be loaded (can't run as single file anymore)

### Developer-Facing Changes

**Architecture:**
- Single monolithic function → 10+ modular, single-purpose modules
- Mixed state across global object → Centralized State machine
- Implicit error handling → Explicit logging with Debug module
- No event tracking → Full event history with History module
- Configuration hardcoded → Validated Config module
- Coupled API/polling → Separated API, WarDetector, HospitalTracker
- UI and logic mixed → Separated UIRenderer from business logic

**Benefits:**
- Easy to add new features without touching existing modules
- Changes to one subsystem don't affect others
- Testing individual modules is straightforward
- State is always consistent and observable
- Errors are tracked and can be recovered from

## Migration Steps

### For End Users

1. **Uninstall v1.0.0**
   - Open Tampermonkey dashboard
   - Remove "Torn War Call Panel" (v1.0.0)
   - Delete any stored settings if prompted

2. **Install v2.0.0**
   - Copy code from tampermonkey/torn-war-call-panel.user.js into a new Tampermonkey script
   - Ensure ALL module files are loaded (see Load Order section below)
   - Enable the script

3. **Reconfigure**
   - Visit Torn.com
   - Click the Settings (gear) button
   - Re-enter your API key and faction IDs
   - Your old settings from v1.0.0 were intentionally not migrated

### For Developers

If you were running a modified version of v1.0.0:

1. **Identify your changes**
   - Did you modify polling intervals?
   - Did you customize alert messages?
   - Did you add new features?

2. **Port to v2.0.0**
   - Polling interval changes → Modify Config module defaults or use window.TWC.Config.save()
   - Alert messages → Modify UIRenderer or add to History module
   - New features → Create a new module following the pattern in ARCHITECTURE.md
   - Bug fixes → Likely fixed in the refactor; file an issue if not

3. **Test thoroughly**
   - Use browser DevTools (F12) to access window.TWC APIs
   - Check the Debug log: window.TWC.Debug.query()
   - Verify state transitions: window.TWC.State.get()

## Load Order

v2.0.0 requires modules to load in this specific order. If using Tampermonkey's @require:

```javascript
// @require https://example.com/modules/state.js
// @require https://example.com/modules/debug.js
// @require https://example.com/modules/history.js
// @require https://example.com/modules/travel.js
// @require https://example.com/modules/config.js
// @require https://example.com/modules/api.js
// @require https://example.com/modules/travel-display.js
// @require https://example.com/modules/war-detector.js
// @require https://example.com/modules/hospital-tracker.js
// @require https://example.com/modules/ui-renderer.js
// @require https://example.com/tampermonkey/torn-war-call-panel.user.js
```

**Alternative:** Concatenate all modules into a single file with the correct order (recommended for simplicity).

## Troubleshooting Migration Issues

### "Missing required modules"

**Cause:** Not all modules loaded.

**Fix:**
1. Open browser DevTools (F12)
2. Check the console for error messages
3. Verify all modules are in the correct order
4. Check that module file paths are correct
5. Verify none of your browser extensions are blocking the script

### "Invalid type for X" (Config validation error)

**Cause:** Stored settings from v1.0.0 are conflicting.

**Fix:**
1. Clear browser storage for the site:
   - Right-click page → Inspect → Application/Storage → Clear all
   - Reload Torn.com
   - Re-enter settings in the Settings panel

2. Or manually clear from console:
   ```javascript
   // Clear all TWC settings
   for (let key in localStorage) {
     if (key.startsWith('twc_')) delete localStorage[key];
   }
   location.reload();
   ```

### Panel not appearing

**Cause:** Script failed during initialization.

**Fix:**
1. Open DevTools console (F12)
2. Look for error messages starting with [TWC]
3. Check the most recent error
4. Common causes:
   - Missing API key or faction ID
   - One of the modules failed to load
   - Network error fetching from API

**Debug:**
```javascript
window.TWC.Config.validate();  // Check for config errors
window.TWC.State.get();        // Check state
window.TWC.Debug.query();      // Check for errors
```

### Settings not saving

**Cause:** GM storage not working or script lost permissions.

**Fix:**
1. Verify Tampermonkey granted the script storage permissions
2. Check Tampermonkey Settings → Grant Access to this page
3. Verify the site is not in an incognito/private window
4. Try a different browser if possible

## What Can Be Customized

### Via UI (Settings Panel)
- API Key
- Faction IDs
- Hospital warning threshold (seconds)
- Poll intervals (milliseconds)
- Panel dimensions and collapse state

### Via Console
```javascript
// Change alert threshold
window.TWC.Config.save('warnWindowSeconds', 30);

// Faster war detection during active war
window.TWC.Config.save('warStatusPollIntervalMs', 15000);

// Faster hospital updates
window.TWC.Config.save('hospitalPollIntervalMs', 8000);

// Save and persist
window.TWC.Config.save('customSetting', value);
```

### Via Code Modifications
- Status messages and colors → Modify STATUS_CONFIG in ui-renderer.js
- Alert behavior → Modify HospitalTracker.onAlert() handler in main script
- War state classification → Modify classifyState() in war-detector.js
- Travel formatting → Modify TravelDisplay.getDisplay()

## Data Migration

**v1.0.0 Storage Keys:**
```
twc_apiKey
twc_ownFactionId
twc_enemyFactionId
twc_collapsed
```

**v2.0.0 Storage Keys:**
```
twc_apiKey
twc_ownFactionId
twc_enemyFactionId
twc_warStatusPollIntervalMs
twc_hospitalPollIntervalMs
twc_warnWindowSeconds
twc_panelWidth
twc_panelHeight
twc_panelCollapsed
twc_panelHidden
twc_lastInitTime
```

**Difference:** v2.0.0 stores all settings; v1.0.0 only stored credentials and collapse state.

### Manual Migration Script

If you want to preserve API credentials from v1.0.0:

```javascript
// In browser console on any Torn page with v2.0.0 loaded
const oldKey = localStorage.getItem('twc_apiKey');
const oldOwn = localStorage.getItem('twc_ownFactionId');
const oldEnemy = localStorage.getItem('twc_enemyFactionId');

if (oldKey) window.TWC.Config.save('apiKey', oldKey);
if (oldOwn) window.TWC.Config.save('ownFactionId', oldOwn);
if (oldEnemy) window.TWC.Config.save('enemyFactionId', oldEnemy);

console.log('Migration complete. Reload page.');
location.reload();
```

## Verifying Successful Migration

1. Panel appears
2. Status header visible with state (Syncing... → Peace/War Active/etc)
3. No console errors (check DevTools)
4. Hospital lists updating (check every 12 seconds)
5. Travel info showing if you're traveling
6. Settings button works (click gear icon)
7. Debug panel works (click wrench icon)

## Rollback to v1.0.0

If you need to return to v1.0.0:

1. Uninstall v2.0.0 from Tampermonkey
2. Create a new script with v1.0.0 code
3. Clear storage: localStorage.clear() in console
4. Reload Torn.com
5. Re-configure settings

Your old v1.0.0 script can coexist with v2.0.0 in Tampermonkey; disable one or the other as needed.

## Getting Help

If you encounter issues:

1. Check this guide — Most issues are covered above
2. Check the console (F12) — Error messages are logged
3. Use the debug API:
   ```javascript
   window.TWC.Debug.query();  // All logs
   window.TWC.Debug.query({ severity: 'error' });  // Just errors
   window.TWC.History.all();  // User events
   window.TWC.State.get();    // Current state
   ```
4. Check ARCHITECTURE.md — Detailed module documentation
5. File an issue with console output and the result of the debug API calls above

## Version History

- v2.0.0 — Major refactor: modular architecture, state machine, debug system, travel integration
- v1.0.0 — Initial release: monolithic userscript with hospital timer tracking

See CHANGELOG.md for detailed version history.
