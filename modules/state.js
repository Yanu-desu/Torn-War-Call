// Torn War Call — State module
// Single source of truth for the faction's war status. Every other module
// reads state through here instead of re-deriving it from raw API data.

window.TWC = window.TWC || {};

window.TWC.State = (function () {
  'use strict';

  const STATES = Object.freeze({
    UNKNOWN: 'unknown',       // still syncing / not enough data yet — never guess past this
    PEACE: 'peace',           // no war scheduled
    WAR_PREP: 'war_prep',     // war scheduled, not started
    ACTIVE_WAR: 'active_war', // war ongoing
    WAR_ENDED: 'war_ended',   // war finished, within the post-war display window
    FAILURE: 'failure',       // script-level failure — overrides everything else
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
