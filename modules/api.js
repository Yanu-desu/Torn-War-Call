// Torn War Call - API module
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
