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

// CONSOLIDATED BUILD: All modules bundled for single-file deployment

// ==================== state ====================
// Torn War Call â€” State module
// Single source of truth for the faction's war status. Every other module
// reads state through here instead of re-deriving it from raw API data.

window.TWC = window.TWC || {};

window.TWC.State = (function () {
  'use strict';

  const STATES = Object.freeze({
    UNKNOWN: 'unknown',       // still syncing / not enough data yet â€” never guess past this
    PEACE: 'peace',           // no war scheduled
    WAR_PREP: 'war_prep',     // war scheduled, not started
    ACTIVE_WAR: 'active_war', // war ongoing
    WAR_ENDED: 'war_ended',   // war finished, within the post-war display window
    FAILURE: 'failure',       // script-level failure â€” overrides everything else
  });

  let current = STATES.UNKNOWN;
  let context = {};
  const listeners = [];

  function set(newState, newContext) {
    newContext = newContext || {};
    const changed = newState !== current || JSON.stringify(newContext) !== JSON.stringify(context);
    if (!changed) return;

    const oldState = current;
    current = newState;
    context = newContext;

    listeners.forEach((fn) => {
      try {
        fn(current, context);
      } catch (e) {
        console.error('[TWC.State] listener threw', e);
      }
    });
  }

  function get() {
    return { state: current, context };
  }

  function subscribe(fn) {
    listeners.push(fn);
    // Call immediately with current state
    try {
      fn(current, context);
    } catch (e) {
      console.error('[TWC.State] Initial subscriber call threw', e);
    }
    return function unsubscribe() {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  return { STATES, set, get, subscribe };
})();


// ==================== debug ====================
// Torn War Call â€” Debug module
// Structured logging with severity, source, and timestamp. Any module can log
// here; the UI queries it for display instead of each module keeping its own log.

window.TWC = window.TWC || {};

window.TWC.Debug = (function () {
  'use strict';

  const SEVERITY = Object.freeze({
    INFO: 'info',
    SUCCESS: 'success',
    WARNING: 'warning',
    ERROR: 'error',
    CRITICAL: 'critical',
  });

  const SEVERITY_ORDER = [SEVERITY.INFO, SEVERITY.SUCCESS, SEVERITY.WARNING, SEVERITY.ERROR, SEVERITY.CRITICAL];
  const MAX_LOGS = 300;

  let logs = [];
  const listeners = [];

  function log(severity, source, message) {
    const entry = { time: new Date(), severity, source, message };
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs.pop();

    const consoleMethod =
      severity === SEVERITY.CRITICAL || severity === SEVERITY.ERROR ? 'error' :
      severity === SEVERITY.WARNING ? 'warn' : 'log';
    console[consoleMethod](`[TWC:${source}]`, message);

    listeners.forEach((fn) => {
      try { fn(entry); } catch (e) { /* never let a listener recursively break logging */ }
    });

    // A critical failure always overrides whatever state we're in.
    if (severity === SEVERITY.CRITICAL && window.TWC.State) {
      window.TWC.State.set(window.TWC.State.STATES.FAILURE, { reason: message, source });
    }
  }

  function query(filters) {
    filters = filters || {};
    const severity = filters.severity || null;
    const search = (filters.search || '').toLowerCase();

    return logs.filter((entry) => {
      if (severity && entry.severity !== severity) return false;
      if (search) {
        const haystack = `${entry.source} ${entry.message}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  function clear() {
    logs = [];
  }

  function onLog(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  return { SEVERITY, SEVERITY_ORDER, log, query, clear, onLog };
})();


// ==================== history ====================
// Torn War Call â€” History module
// Tracks meaningful EVENTS (war detected, ping sent, settings changed...) as
// opposed to Debug's granular technical logs. Different audience, different purpose:
// this is "what happened", Debug is "what the code was doing".

window.TWC = window.TWC || {};

window.TWC.History = (function () {
  'use strict';

  const MAX_ENTRIES = 150;
  let entries = [];
  const listeners = [];

  function record(eventType, message) {
    const entry = { time: new Date(), eventType, message };
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.pop();

    listeners.forEach((fn) => {
      try { fn(entry); } catch (e) { /* don't let a bad listener break history */ }
    });
  }

  function all() {
    return entries;
  }

  function onRecord(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  return { record, all, onRecord };
})();


// ==================== travel ====================
// Torn War Call â€” Travel module
// Tracks the KEY OWNER's own travel status. Torn's API only exposes a live
// travel timer for the account the key belongs to â€” there is no way to see
// a faction member's travel countdown, so this is inherently personal, not
// faction-wide like the hospital tracker.
//
// Field names (destination, method, timestamp, departed, time_left) come from
// Torn's long-standing v1 `user?selections=travel` shape. Stable for years,
// but verified against live API v2 response format.

window.TWC = window.TWC || {};

window.TWC.Travel = (function () {
  'use strict';

  const PHASES = Object.freeze({
    NONE: 'none',           // not traveling
    DEPARTED: 'departed',   // outbound, in the air
    ABROAD: 'abroad',       // landed at destination, no return timer exists yet
    RETURNING: 'returning', // heading back to Torn â€” this is when "back in Torn" ETA becomes knowable
    ARRIVED: 'arrived',     // back in Torn (transient â€” clears on next poll)
  });

  let current = { phase: PHASES.NONE };
  const listeners = [];
  let loggedRawShapeOnce = false;

  function classify(raw) {
    if (!raw || !raw.destination) return { phase: PHASES.NONE };

    const now = Math.floor(Date.now() / 1000);
    const arrivalTs = raw.timestamp || 0;
    const timeLeft = Math.max(0, raw.time_left ?? (arrivalTs - now));
    const isReturnLeg = raw.destination === 'Torn';

    if (timeLeft <= 0) {
      return isReturnLeg
        ? { phase: PHASES.ARRIVED }
        : { phase: PHASES.ABROAD, destination: raw.destination, arrivalTs, method: raw.method };
    }

    return {
      phase: isReturnLeg ? PHASES.RETURNING : PHASES.DEPARTED,
      destination: raw.destination,
      method: raw.method,
      arrivalTs,
      timeLeft,
    };
  }

  function update(raw, Debug) {
    if (Debug && !loggedRawShapeOnce && raw) {
      loggedRawShapeOnce = true;
      Debug.log(Debug.SEVERITY.INFO, 'travel', `Raw travel response: ${JSON.stringify(raw)}`);
    }

    const next = classify(raw);
    const changed = next.phase !== current.phase || next.destination !== current.destination;
    current = next;

    if (changed) {
      if (Debug) {
        Debug.log(Debug.SEVERITY.INFO, 'travel', `Travel phase: ${next.phase}${next.destination ? ' â†’ ' + next.destination : ''}`);
      }
      listeners.forEach((fn) => { 
        try { fn(current); } catch (e) { 
          console.error('[TWC.Travel] listener threw:', e);
        } 
      });
    }
  }

  function get() {
    return current;
  }

  function onChange(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  return { PHASES, update, get, onChange };
})();


// ==================== config ====================
// Torn War Call â€” Config module
// Centralized configuration with validation and persistence.
// Provides defaults, loads from GM storage, and validates required fields.

window.TWC = window.TWC || {};

window.TWC.Config = (function () {
  'use strict';

  const VERSION = '2.0.0';
  const BUILD_DATE = '2026-08-07';

  // Schema: { key, type, default, required }
  const SCHEMA = [
    { key: 'apiKey', type: 'string', default: '', required: true },
    { key: 'ownFactionId', type: 'string', default: '', required: true },
    { key: 'enemyFactionId', type: 'string', default: '', required: false },
    { key: 'warStatusPollIntervalMs', type: 'number', default: 30000, required: false },
    { key: 'hospitalPollIntervalMs', type: 'number', default: 12000, required: false },
    { key: 'warnWindowSeconds', type: 'number', default: 60, required: false },
    { key: 'panelWidth', type: 'number', default: 400, required: false },
    { key: 'panelHeight', type: 'number', default: 500, required: false },
    { key: 'panelCollapsed', type: 'boolean', default: false, required: false },
    { key: 'panelHidden', type: 'boolean', default: false, required: false },
    { key: 'lastInitTime', type: 'number', default: 0, required: false },
  ];

  let config = {};

  function load() {
    SCHEMA.forEach((field) => {
      const stored = GM_getValue(`twc_${field.key}`);
      config[field.key] = stored !== undefined ? stored : field.default;
    });
  }

  function save(key, value) {
    config[key] = value;
    GM_setValue(`twc_${key}`, value);
  }

  function get(key) {
    return key ? config[key] : { ...config };
  }

  function validate() {
    const errors = [];
    SCHEMA.forEach((field) => {
      if (field.required && !config[field.key]) {
        errors.push(`Missing required setting: ${field.key}`);
      }
      if (config[field.key] && typeof config[field.key] !== field.type) {
        errors.push(`Invalid type for ${field.key}: expected ${field.type}, got ${typeof config[field.key]}`);
      }
    });
    return errors;
  }

  function exportConfig() {
    return {
      version: VERSION,
      exported: new Date().toISOString(),
      data: { ...config },
    };
  }

  function importConfig(json) {
    try {
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      if (!parsed.data || typeof parsed.data !== 'object') {
        throw new Error('Invalid export: missing data field');
      }
      Object.entries(parsed.data).forEach(([key, value]) => {
        if (SCHEMA.find((f) => f.key === key)) {
          save(key, value);
        }
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  return {
    VERSION,
    BUILD_DATE,
    load,
    save,
    get,
    validate,
    exportConfig,
    importConfig,
  };
})();


// ==================== api ====================
// Torn War Call â€” API module
// Centralized Torn API interaction layer. Handles requests with proper error handling
// and the quirk that Torn returns HTTP 200 even on logical errors.

window.TWC = window.TWC || {};

window.TWC.API = (function () {
  'use strict';

  const BASE = 'https://api.torn.com/v2';

  function tornGet(path, apiKey) {
    return new Promise((resolve, reject) => {
      if (!apiKey) return reject(new Error('No API key provided'));

      const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}key=${apiKey}`;
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        onload: (res) => {
          try {
            const data = JSON.parse(res.responseText);
            if (data.error) {
              return reject(new Error(`${data.error.code}: ${data.error.error}`));
            }
            resolve(data);
          } catch (e) {
            reject(new Error(`Response parse error: ${e.message}`));
          }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timeout')),
      });
    });
  }

  // Fetch faction members and their statuses
  async function getFactionMembers(factionId, apiKey) {
    const data = await tornGet(`/faction/${factionId}/members`, apiKey);
    const members = data.members || [];
    return members.map((m) => ({
      id: m.id,
      name: m.name,
      level: m.level,
      state: m.status?.state ?? 'Unknown',
      until: m.status?.until ?? 0,
    }));
  }

  // Fetch active ranked war for a faction
  async function getActiveRankedWar(factionId, apiKey) {
    const data = await tornGet(`/faction/${factionId}/wars`, apiKey);
    const ranked = data.wars?.ranked;

    if (!ranked || ranked.end) {
      return null; // no active war
    }

    const opponent = (ranked.factions || []).find((f) => String(f.id) !== String(factionId));
    if (!opponent) return null;

    return {
      warId: ranked.war_id ?? ranked.id,
      enemyFactionId: opponent.id,
      enemyFactionName: opponent.name,
      startTime: ranked.start ?? 0,
      endTime: ranked.end ?? 0,
    };
  }

  // Fetch current user's travel status (requires user key, not faction key)
  async function getUserTravel(apiKey) {
    const data = await tornGet('/user?selections=travel', apiKey);
    return data.travel || null;
  }

  return {
    getFactionMembers,
    getActiveRankedWar,
    getUserTravel,
  };
})();


// ==================== travel-display ====================
// Torn War Call â€” Travel Display module
// Formats travel state for UI consumption. Transforms raw travel data into
// human-readable ETAs and status messages. Integrates with Travel module.

window.TWC = window.TWC || {};

window.TWC.TravelDisplay = (function () {
  'use strict';

  const TRAVEL = window.TWC.Travel;

  // Formats time remaining as "Xh Ym" or "Xs"
  function formatDuration(seconds) {
    if (seconds <= 0) return 'now';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  function formatTime(unixSeconds) {
    const date = new Date(unixSeconds * 1000);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  // Build display object for UI to consume
  function getDisplay() {
    const travel = TRAVEL.get();
    const now = Math.floor(Date.now() / 1000);

    if (travel.phase === TRAVEL.PHASES.NONE) {
      return {
        active: false,
        message: 'Not traveling',
      };
    }

    if (travel.phase === TRAVEL.PHASES.DEPARTED) {
      return {
        active: true,
        phase: 'departed',
        destination: travel.destination,
        method: travel.method,
        arrivalTime: formatTime(travel.arrivalTs),
        timeRemaining: formatDuration(travel.timeLeft),
        primaryMessage: `Arriving ${travel.destination} in ${formatDuration(travel.timeLeft)}`,
        secondaryMessage: `ETA: ${formatTime(travel.arrivalTs)}`,
      };
    }

    if (travel.phase === TRAVEL.PHASES.ABROAD) {
      return {
        active: true,
        phase: 'abroad',
        destination: travel.destination,
        method: travel.method,
        primaryMessage: `You are in ${travel.destination}`,
        secondaryMessage: 'Awaiting return trip...',
      };
    }

    if (travel.phase === TRAVEL.PHASES.RETURNING) {
      const timeToTorn = Math.max(0, travel.arrivalTs - now);
      return {
        active: true,
        phase: 'returning',
        destination: travel.destination,
        method: travel.method,
        arrivalTime: formatTime(travel.arrivalTs),
        timeRemaining: formatDuration(timeToTorn),
        primaryMessage: `Returning to Torn in ${formatDuration(timeToTorn)}`,
        secondaryMessage: `ETA: ${formatTime(travel.arrivalTs)}`,
      };
    }

    if (travel.phase === TRAVEL.PHASES.ARRIVED) {
      return {
        active: true,
        phase: 'arrived',
        primaryMessage: 'Welcome back to Torn!',
      };
    }

    return {
      active: false,
      message: 'Unknown travel state',
    };
  }

  return { getDisplay, formatDuration, formatTime };
})();


// ==================== war-detector ====================
// Torn War Call â€” War Detector module
// Polls faction war status and drives state transitions.
// Tracks war lifecycle: Peace -> Prep -> Active -> Ended -> Peace

window.TWC = window.TWC || {};

window.TWC.WarDetector = (function () {
  'use strict';

  const DEBUG = window.TWC.Debug;
  const STATE = window.TWC.State;
  const API = window.TWC.API;
  const CONFIG = window.TWC.Config;

  let pollTimer = null;
  let lastWarId = null;
  let warEndTime = null;
  const POST_WAR_DISPLAY_HOURS = 48;

  function classifyState(war, now) {
    if (!war) {
      return { state: STATE.STATES.PEACE };
    }

    const hasStarted = war.startTime && now >= war.startTime;
    const hasEnded = war.endTime && now >= war.endTime;

    if (!hasStarted) {
      return { state: STATE.STATES.WAR_PREP, war };
    } else if (!hasEnded) {
      return { state: STATE.STATES.ACTIVE_WAR, war };
    } else {
      const secondsSinceEnd = now - war.endTime;
      const postWarWindow = POST_WAR_DISPLAY_HOURS * 3600;
      if (secondsSinceEnd < postWarWindow) {
        return { state: STATE.STATES.WAR_ENDED, war };
      } else {
        return { state: STATE.STATES.PEACE };
      }
    }
  }

  async function poll() {
    if (!CONFIG.get('apiKey') || !CONFIG.get('ownFactionId')) {
      return;
    }

    try {
      const war = await API.getActiveRankedWar(CONFIG.get('ownFactionId'), CONFIG.get('apiKey'));
      const now = Math.floor(Date.now() / 1000);
      const classified = classifyState(war, now);

      // Track war transitions for dedup logic
      if (war && war.warId !== lastWarId) {
        lastWarId = war.warId;
        if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'WarDetector', `New war detected: vs ${war.enemyFactionName} [${war.enemyFactionId}]`);
      }

      STATE.set(classified.state, classified);
    } catch (e) {
      if (DEBUG) DEBUG.log(DEBUG.SEVERITY.ERROR, 'WarDetector', `Poll failed: ${e.message}`);
    }
  }

  function start() {
    if (pollTimer) return; // already running
    if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'WarDetector', 'Starting war detector');
    poll(); // immediate first poll
    const interval = CONFIG.get('warStatusPollIntervalMs') || 30000;
    pollTimer = setInterval(poll, interval);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'WarDetector', 'War detector stopped');
    }
  }

  return { start, stop, poll };
})();


// ==================== hospital-tracker ====================
// Torn War Call â€” Hospital Tracker module
// Polls faction rosters and tracks hospital status.
// De-duplicates alerts per hospital stay; fires event when someone enters warn window.

window.TWC = window.TWC || {};

window.TWC.HospitalTracker = (function () {
  'use strict';

  const DEBUG = window.TWC.Debug;
  const API = window.TWC.API;
  const CONFIG = window.TWC.Config;

  let pollTimer = null;
  let allyMembers = [];
  let enemyMembers = [];

  // Track which (userId, until) pairs we've already alerted for
  const notifiedAlly = new Map();
  const notifiedEnemy = new Map();

  const listeners = [];

  function onAlert(callback) {
    listeners.push(callback);
    return function unsubscribe() {
      const i = listeners.indexOf(callback);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  async function checkFaction(factionId, side, notifiedMap) {
    if (!factionId) return;

    try {
      const members = await API.getFactionMembers(factionId, CONFIG.get('apiKey'));
      const now = Math.floor(Date.now() / 1000);
      const warnWindow = CONFIG.get('warnWindowSeconds') || 60;

      if (side === 'ally') {
        allyMembers = members;
      } else {
        enemyMembers = members;
      }

      for (const member of members) {
        const inHospital = member.state === 'Hospital' && member.until > now;

        if (!inHospital) {
          notifiedMap.delete(member.id);
          continue;
        }

        const secondsLeft = member.until - now;
        const alreadyNotifiedThisStay = notifiedMap.get(member.id) === member.until;

        if (secondsLeft <= warnWindow && !alreadyNotifiedThisStay) {
          notifiedMap.set(member.id, member.until);
          listeners.forEach((fn) => {
            try {
              fn({ side, member, secondsLeft });
            } catch (e) {
              if (DEBUG) DEBUG.log(DEBUG.SEVERITY.ERROR, 'HospitalTracker', `Alert listener threw: ${e.message}`);
            }
          });
        }
      }
    } catch (e) {
      if (DEBUG) DEBUG.log(DEBUG.SEVERITY.ERROR, 'HospitalTracker', `${side} poll failed: ${e.message}`);
    }
  }

  async function poll() {
    const ownFactionId = CONFIG.get('ownFactionId');
    const enemyFactionId = CONFIG.get('enemyFactionId');

    await Promise.allSettled([
      checkFaction(ownFactionId, 'ally', notifiedAlly),
      checkFaction(enemyFactionId, 'enemy', notifiedEnemy),
    ]);
  }

  function getMembers(side) {
    return side === 'ally' ? allyMembers : enemyMembers;
  }

  function start() {
    if (pollTimer) return;
    if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'HospitalTracker', 'Starting hospital tracker');
    poll();
    const interval = CONFIG.get('hospitalPollIntervalMs') || 12000;
    pollTimer = setInterval(poll, interval);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'HospitalTracker', 'Hospital tracker stopped');
    }
  }

  return { start, stop, poll, onAlert, getMembers };
})();


// ==================== ui-renderer ====================
// Torn War Call â€” UI Renderer module
// Handles all presentation and DOM manipulation. Pure UI layer with no business logic.
// Listens to State and other modules, renders when data changes.

window.TWC = window.TWC || {};

window.TWC.UIRenderer = (function () {
  'use strict';

  const STATE = window.TWC.State;
  const TRAVEL_DISPLAY = window.TWC.TravelDisplay;
  const CONFIG = window.TWC.Config;
  const DEBUG = window.TWC.Debug;

  let panelElement = null;
  let isInitialized = false;

  // Status styling config
  const STATUS_CONFIG = {
    [STATE.STATES.UNKNOWN]: {
      text: 'Syncing...',
      color: '#95a5a6',
      icon: 'ðŸ”„',
    },
    [STATE.STATES.PEACE]: {
      text: 'At Peace',
      color: '#27ae60',
      icon: 'â˜®',
    },
    [STATE.STATES.WAR_PREP]: {
      text: 'War Scheduled',
      color: '#f39c12',
      icon: 'âš™',
    },
    [STATE.STATES.ACTIVE_WAR]: {
      text: 'War Active',
      color: '#e74c3c',
      icon: 'âš”',
    },
    [STATE.STATES.WAR_ENDED]: {
      text: 'War Ended',
      color: '#3498db',
      icon: 'âœ“',
    },
    [STATE.STATES.FAILURE]: {
      text: 'Script Failure',
      color: '#c0392b',
      icon: 'âœ•',
    },
  };

  function createStyles() {
    const style = document.createElement('style');
    style.id = 'twc-styles';
    style.textContent = `
      #twc-panel {
        position: fixed;
        top: 100px;
        right: 20px;
        width: ${CONFIG.get('panelWidth')}px;
        max-width: 90vw;
        z-index: 99999;
        background: #1b1e21;
        border: 1px solid #333;
        border-radius: 8px;
        color: #e6e6e6;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        display: flex;
        flex-direction: column;
        max-height: 90vh;
        overflow: hidden;
      }

      #twc-panel.hidden {
        display: none;
      }

      #twc-header {
        background: #262a2e;
        padding: 12px 14px;
        border-bottom: 1px solid #333;
        border-radius: 8px 8px 0 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
        user-select: none;
      }

      #twc-header h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #twc-status {
        background: #1e2327;
        padding: 8px 12px;
        border-bottom: 1px solid #333;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        font-weight: 500;
      }

      #twc-status-icon {
        min-width: 16px;
        text-align: center;
      }

      #twc-status-text {
        flex: 1;
      }

      #twc-body {
        flex: 1;
        overflow-y: auto;
        padding: 10px;
      }

      #twc-body.hidden { display: none; }

      .twc-section {
        margin-bottom: 12px;
      }

      .twc-section-title {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        color: #95a5a6;
        margin-bottom: 6px;
        opacity: 0.8;
      }

      .twc-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 8px;
        border-radius: 4px;
        margin-bottom: 3px;
        background: rgba(52, 73, 94, 0.3);
        font-size: 11px;
      }

      .twc-row.warn {
        background: rgba(231, 76, 60, 0.35);
        animation: twc-pulse 1.2s infinite;
      }

      .twc-row.ally-warn {
        background: rgba(46, 204, 113, 0.35);
        animation: twc-pulse 1.2s infinite;
      }

      @keyframes twc-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }

      .twc-empty {
        color: #7f8c8d;
        font-style: italic;
        padding: 6px 8px;
        font-size: 11px;
      }

      #twc-travel {
        background: rgba(52, 152, 219, 0.25);
        border-left: 3px solid #3498db;
        padding: 8px 10px;
        border-radius: 4px;
        margin-bottom: 10px;
      }

      #twc-travel.returning {
        background: rgba(230, 126, 34, 0.25);
        border-left-color: #e67e22;
      }

      #twc-travel-primary {
        font-weight: 600;
        margin-bottom: 2px;
      }

      #twc-travel-secondary {
        font-size: 10px;
        opacity: 0.8;
      }

      #twc-footer {
        background: #262a2e;
        padding: 8px 12px;
        border-top: 1px solid #333;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 10px;
        gap: 8px;
      }

      #twc-footer-controls {
        display: flex;
        gap: 6px;
      }

      #twc-footer-controls button {
        background: #34495e;
        color: #ecf0f1;
        border: none;
        padding: 4px 8px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 10px;
        transition: background 0.2s;
      }

      #twc-footer-controls button:hover {
        background: #2c3e50;
      }

      #twc-toggle-btn, #twc-hide-btn {
        min-width: 20px;
      }

      #twc-version {
        font-size: 9px;
        opacity: 0.6;
      }
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'twc-panel';
    if (CONFIG.get('panelHidden')) panel.classList.add('hidden');

    panel.innerHTML = `
      <div id="twc-header">
        <h2>
          <span id="twc-icon">ðŸ“Š</span>
          Torn War Call
        </h2>
        <div id="twc-header-actions">
          <button id="twc-toggle-btn" title="Toggle panel">â–¾</button>
        </div>
      </div>

      <div id="twc-status">
        <span id="twc-status-icon">ðŸ”„</span>
        <span id="twc-status-text">Syncing...</span>
      </div>

      <div id="twc-body">
        <div id="twc-travel" class="hidden"></div>
        <div id="twc-enemy-section" class="twc-section">
          <div class="twc-section-title">Enemy â€” Coming Out</div>
          <div id="twc-enemy-list"></div>
        </div>
        <div id="twc-ally-section" class="twc-section">
          <div class="twc-section-title">Ally â€” Almost Out</div>
          <div id="twc-ally-list"></div>
        </div>
      </div>

      <div id="twc-footer">
        <span id="twc-version">v${CONFIG.VERSION}</span>
        <div id="twc-footer-controls">
          <button id="twc-debug-btn" title="Debug">ðŸ”§</button>
          <button id="twc-settings-btn" title="Settings">âš™</button>
          <button id="twc-hide-btn" title="Hide UI">âœ•</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    panelElement = panel;

    // Event handlers
    document.getElementById('twc-toggle-btn').addEventListener('click', togglePanel);
    document.getElementById('twc-hide-btn').addEventListener('click', hidePanel);
    document.getElementById('twc-debug-btn').addEventListener('click', openDebug);
    document.getElementById('twc-settings-btn').addEventListener('click', openSettings);

    makeDraggable(panel, document.getElementById('twc-header'));
  }

  function makeDraggable(element, handle) {
    let dragging = false, offX = 0, offY = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      offX = e.clientX - element.offsetLeft;
      offY = e.clientY - element.offsetTop;
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      element.style.left = `${e.clientX - offX}px`;
      element.style.top = `${e.clientY - offY}px`;
      element.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => (dragging = false));
  }

  function togglePanel() {
    const body = document.getElementById('twc-body');
    const btn = document.getElementById('twc-toggle-btn');
    const isCollapsed = CONFIG.get('panelCollapsed');
    CONFIG.save('panelCollapsed', !isCollapsed);
    body.classList.toggle('hidden');
    btn.textContent = isCollapsed ? 'â–¾' : 'â–¸';
  }

  function hidePanel() {
    CONFIG.save('panelHidden', true);
    if (panelElement) panelElement.classList.add('hidden');
  }

  function showPanel() {
    CONFIG.save('panelHidden', false);
    if (panelElement) panelElement.classList.remove('hidden');
  }

  function openDebug() {
    // TODO: Implement debug panel
    if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'UI', 'Debug panel requested');
  }

  function openSettings() {
    // TODO: Implement settings panel
    if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'UI', 'Settings panel requested');
  }

  function updateStatus(state, context) {
    const config = STATUS_CONFIG[state] || STATUS_CONFIG[STATE.STATES.UNKNOWN];
    const icon = document.getElementById('twc-status-icon');
    const text = document.getElementById('twc-status-text');
    const statusEl = document.getElementById('twc-status');

    if (icon) icon.textContent = config.icon;
    if (text) text.textContent = config.text;
    if (statusEl) statusEl.style.borderLeft = `3px solid ${config.color}`;
  }

  function updateTravelDisplay() {
    const travelDisplay = TRAVEL_DISPLAY.getDisplay();
    const travelEl = document.getElementById('twc-travel');

    if (!travelDisplay.active) {
      travelEl.classList.add('hidden');
      return;
    }

    travelEl.classList.remove('hidden');
    if (travelDisplay.phase === 'returning') {
      travelEl.classList.add('returning');
    } else {
      travelEl.classList.remove('returning');
    }

    const primary = document.getElementById('twc-travel-primary');
    const secondary = document.getElementById('twc-travel-secondary');

    if (primary) primary.textContent = travelDisplay.primaryMessage;
    if (secondary) secondary.textContent = travelDisplay.secondaryMessage || '';
  }

  function formatTime(seconds) {
    if (seconds <= 0) return 'now';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function updateHospitalList(side, members) {
    const now = Math.floor(Date.now() / 1000);
    const warnWindow = CONFIG.get('warnWindowSeconds') || 60;
    const elementId = side === 'ally' ? 'twc-ally-list' : 'twc-enemy-list';
    const container = document.getElementById(elementId);

    if (!container) return;

    const hospitalized = members
      .filter((m) => m.state === 'Hospital' && m.until > now)
      .map((m) => ({ ...m, secondsLeft: m.until - now }))
      .sort((a, b) => a.secondsLeft - b.secondsLeft);

    if (hospitalized.length === 0) {
      container.innerHTML = '<div class="twc-empty">Nobody hospitalized</div>';
      return;
    }

    container.innerHTML = hospitalized
      .map((m) => {
        const isWarning = m.secondsLeft <= warnWindow;
        const warnClass = side === 'ally' ? 'ally-warn' : 'warn';
        return `
          <div class="twc-row ${isWarning ? warnClass : ''}">
            <span>${m.name} [${m.level}]</span>
            <span>${formatTime(m.secondsLeft)}</span>
          </div>
        `;
      })
      .join('');
  }

  function render() {
    if (!panelElement) return;

    const { state, context } = STATE.get();
    updateStatus(state, context);
    updateTravelDisplay();

    // Update hospital lists
    if (window.TWC.HospitalTracker) {
      updateHospitalList('ally', window.TWC.HospitalTracker.getMembers('ally'));
      updateHospitalList('enemy', window.TWC.HospitalTracker.getMembers('enemy'));
    }
  }

  function initialize() {
    if (isInitialized) return;
    createStyles();
    createPanel();
    isInitialized = true;

    // Listen to state changes
    if (STATE) STATE.subscribe(render);

    // Update travel display every second
    if (TRAVEL_DISPLAY) {
      setInterval(() => {
        if (!CONFIG.get('panelHidden')) {
          updateTravelDisplay();
        }
      }, 1000);
    }

    // Update hospital lists periodically (UI tick)
    setInterval(() => {
      if (!CONFIG.get('panelHidden')) {
        render();
      }
    }, 1000);

    if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'UI', 'UI initialized');
  }

  return {
    initialize,
    render,
    showPanel,
    hidePanel,
    updateStatus,
  };
})();


// ==================== MAIN INITIALIZATION ====================

(function () {
  'use strict';

  // Verify all modules are loaded
  const modules = [
    'Config', 'State', 'Debug', 'Travel', 'TravelDisplay',
    'API', 'HospitalTracker', 'WarDetector', 'UIRenderer', 'History'
  ];

  const missing = modules.filter((m) => !window.TWC || !window.TWC[m]);
  if (missing.length > 0) {
    console.error('[TWC] Missing required modules:', missing.join(', '));
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

  async function initialize() {
    try {
      DEBUG.log(DEBUG.SEVERITY.INFO, 'Main', `Initializing TWC v${CONFIG.VERSION}`);

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

      CONFIG.save('lastInitTime', Math.floor(Date.now() / 1000));
      HISTORY.record('init', `Script initialized v${CONFIG.VERSION}`);

      UI.initialize();

      WAR_DETECTOR.start();
      HOSPITAL.start();

      setInterval(async () => {
        try {
          const travel = await API.getUserTravel(CONFIG.get('apiKey'));
          TRAVEL.update(travel, DEBUG);
        } catch (e) {
          DEBUG.log(DEBUG.SEVERITY.WARNING, 'Main', `Travel update failed: ${e.message}`);
        }
      }, 15000);

      STATE.set(STATE.STATES.UNKNOWN, { waiting: 'first poll' });

      HOSPITAL.onAlert(({ side, member, secondsLeft }) => {
        HISTORY.record('ping', `${side === 'ally' ? 'Ally' : 'Enemy'}: ${member.name} in ${secondsLeft}s`);
      });

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

  window.addEventListener('beforeunload', () => {
    WAR_DETECTOR.stop();
    HOSPITAL.stop();
    DEBUG.log(DEBUG.SEVERITY.INFO, 'Main', 'Shutting down gracefully');
  });
})();
