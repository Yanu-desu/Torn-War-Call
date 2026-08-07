// Torn War Call — War Detector module
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
