// Torn War Call - History module
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
