// Torn War Call — Hospital Tracker module
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
