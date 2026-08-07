// ==UserScript==
// @name         Torn War Call Panel
// @namespace    torn-war-call
// @version      2.0.0
// @description  Modular war call bot with hospital timers, travel tracking, and war state awareness
// @author       Torn War Call Contributors
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      api.torn.com
// ==/UserScript==

(function () {
  'use strict';

  // Import modules from global scope
  const modules = [
    'Config',
    'State',
    'Debug',
    'Travel',
    'TravelDisplay',
    'API',
    'HospitalTracker',
    'WarDetector',
    'UIRenderer',
    'History',
  ];

  const missing = modules.filter((m) => !window.TWC || !window.TWC[m]);
  if (missing.length > 0) {
    console.error('[TWC] Missing required modules:', missing.join(', '));
    console.error('[TWC] Make sure all modules are loaded before this script runs.');
    alert('Torn War Call: Missing required modules. Check console for details.');
    return;
  }

  const CONFIG = window.TWC.Config;
  const STATE = window.TWC.State;
  const DEBUG = window.TWC.Debug;
  const TRAVEL = window.TWC.Travel;
  const API = window.TWC.API;
  const HOSPITAL = window.TWC.HospitalTracker;
  const WAR_DETECTOR = window.TWC.WarDetector;
  const UI = window.TWC.UIRenderer;
  const HISTORY = window.TWC.History;

  // ==================== INITIALIZATION ====================

  async function initialize() {
    try {
      DEBUG.log(DEBUG.SEVERITY.INFO, 'Main', `Initializing TWC v${CONFIG.VERSION}`);

      // Load configuration
      CONFIG.load();
      const configErrors = CONFIG.validate();
      if (configErrors.length > 0) {
        configErrors.forEach((err) => {
          DEBUG.log(DEBUG.SEVERITY.WARNING, 'Main', err);
        });
        STATE.set(STATE.STATES.UNKNOWN, { waiting: 'configuration' });
        UI.initialize();
        return;
      }

      // Record initialization
      CONFIG.save('lastInitTime', Math.floor(Date.now() / 1000));
      HISTORY.record('init', `Script initialized v${CONFIG.VERSION}`);

      // Initialize UI
      UI.initialize();

      // Start background workers
      WAR_DETECTOR.start();
      HOSPITAL.start();

      // Set up travel polling
      setInterval(async () => {
        try {
          const travel = await API.getUserTravel(CONFIG.get('apiKey'));
          TRAVEL.update(travel, DEBUG);
        } catch (e) {
          DEBUG.log(DEBUG.SEVERITY.WARNING, 'Main', `Travel update failed: ${e.message}`);
        }
      }, 15000); // Poll travel every 15s

      // Initial state
      STATE.set(STATE.STATES.UNKNOWN, { waiting: 'first poll' });

      // Subscribe to hospital alerts
      HOSPITAL.onAlert(({ side, member, secondsLeft }) => {
        HISTORY.record('ping', `${side === 'ally' ? 'Ally' : 'Enemy'}: ${member.name} in ${secondsLeft}s`);
      });

      // Subscribe to state changes
      STATE.subscribe((state, context) => {
        if (state === STATE.STATES.FAILURE) {
          HISTORY.record('failure', context.reason);
        }
      });

      DEBUG.log(DEBUG.SEVERITY.SUCCESS, 'Main', 'Initialization complete');
    } catch (e) {
      DEBUG.log(DEBUG.SEVERITY.CRITICAL, 'Main', `Initialization failed: ${e.message}`);
      STATE.set(STATE.STATES.FAILURE, { reason: e.message });
    }
  }

  // Wait for DOM to be ready, then initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

  // ==================== GRACEFUL SHUTDOWN ====================

  window.addEventListener('beforeunload', () => {
    WAR_DETECTOR.stop();
    HOSPITAL.stop();
    DEBUG.log(DEBUG.SEVERITY.INFO, 'Main', 'Shutting down gracefully');
  });
})();
