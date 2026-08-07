// Torn War Call — Module Loader
// Loads all TWC modules in dependency order. Include this via @require before the main userscript.
// This ensures all modules are available when the main script runs.

// IMPORTANT: This file should be loaded BEFORE torn-war-call-panel.user.js
// If using locally, load order should be:
// 1. state.js
// 2. debug.js
// 3. history.js
// 4. travel.js
// 5. config.js
// 6. api.js
// 7. travel-display.js
// 8. war-detector.js
// 9. hospital-tracker.js
// 10. ui-renderer.js
// 11. torn-war-call-panel.user.js (main)

window.TWC = window.TWC || {};

console.log('[TWC] Module loader initialized. Modules available:',
  Object.keys(window.TWC).filter(k => k !== 'constructor')
);
