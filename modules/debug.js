// Torn War Call — Debug module
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
