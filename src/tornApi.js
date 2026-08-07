import fetch from 'node-fetch';
import { config } from './config.js';

const BASE = 'https://api.torn.com/v2';

/**
 * Torn's API returns HTTP 200 even on logical errors — the error lives
 * inside the JSON body as `error: { code, error }`. Always check for it.
 */
async function tornGet(path) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}key=${config.apiKey}`;
  const res = await fetch(url, { timeout: 15000 });

  if (!res.ok) {
    throw new Error(`Torn API HTTP ${res.status} on ${path}`);
  }

  const data = await res.json();

  if (data.error) {
    // code 5 = too many requests, code 2 = incorrect key, etc.
    throw new Error(`Torn API error ${data.error.code}: ${data.error.error} (${path})`);
  }

  return data;
}

/**
 * Pulls member roster + status for a faction.
 * Returns a flat array: [{ id, name, level, status: { state, until, description } }, ...]
 *
 * NOTE: Torn periodically tweaks v2 response shapes. If this stops matching,
 * hit the API Playground (torn.com/api.html) against /v2/faction/{id}/members
 * and adjust the mapping below — the polling/notify logic doesn't need to change.
 */
export async function getFactionMembers(factionId) {
  const data = await tornGet(`/faction/${factionId}/members`);
  const members = data.members || [];

  return members.map((m) => ({
    id: m.id,
    name: m.name,
    level: m.level,
    state: m.status?.state ?? 'Unknown',
    until: m.status?.until ?? 0,
    description: m.status?.description ?? '',
  }));
}

/**
 * Finds the currently active ranked war for our faction, if any.
 * Returns { warId, enemyFactionId, enemyFactionName } or null if no active war.
 */
export async function getActiveRankedWar(factionId) {
  const data = await tornGet(`/faction/${factionId}/wars`);
  const ranked = data.wars?.ranked;

  if (!ranked || ranked.end) {
    // no ranked war object, or it already ended
    return null;
  }

  const opponent = (ranked.factions || []).find((f) => String(f.id) !== String(factionId));
  if (!opponent) return null;

  return {
    warId: ranked.war_id ?? ranked.id,
    enemyFactionId: opponent.id,
    enemyFactionName: opponent.name,
  };
}
