// Torn War Call - Travel module
// Tracks the KEY OWNER's own travel status. Torn's API only exposes a live
// travel timer for the account the key belongs to - there is no way to see
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
    RETURNING: 'returning', // heading back to Torn - this is when "back in Torn" ETA becomes knowable
    ARRIVED: 'arrived',     // back in Torn (transient - clears on next poll)
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
        Debug.log(Debug.SEVERITY.INFO, 'travel', `Travel phase: ${next.phase}${next.destination ? ' -> ' + next.destination : ''}`);
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
