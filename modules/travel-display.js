// Torn War Call - Travel Display module
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
