// ==UserScript==
// @name         Torn War Call Panel
// @namespace    torn-war-call
// @version      1.0.0
// @description  Live in-page dashboard of ally/enemy hospital timers during a ranked war
// @author       you
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.torn.com
// ==/UserScript==

(function () {
  'use strict';

  const WARN_WINDOW_SECONDS = 60;
  const POLL_INTERVAL_MS = 12000; // separate from the Node bot's own polling — this is just for the UI
  const TICK_MS = 1000;

  const state = {
    apiKey: GM_getValue('twc_apiKey', ''),
    ownFactionId: GM_getValue('twc_ownFactionId', ''),
    enemyFactionId: GM_getValue('twc_enemyFactionId', ''),
    ally: [],
    enemy: [],
    collapsed: GM_getValue('twc_collapsed', false),
    lastError: null,
  };

  // ---------- API ----------

  function tornGet(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.torn.com/v2${path}${path.includes('?') ? '&' : '?'}key=${state.apiKey}`,
        onload: (res) => {
          try {
            const data = JSON.parse(res.responseText);
            if (data.error) return reject(new Error(`${data.error.code}: ${data.error.error}`));
            resolve(data);
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error('network error')),
      });
    });
  }

  async function fetchFactionMembers(factionId) {
    const data = await tornGet(`/faction/${factionId}/members`);
    const members = data.members || [];
    return members.map((m) => ({
      id: m.id,
      name: m.name,
      level: m.level,
      state: m.status?.state ?? 'Unknown',
      until: m.status?.until ?? 0,
    }));
  }

  async function pollData() {
    if (!state.apiKey || !state.ownFactionId) return;
    try {
      state.ally = await fetchFactionMembers(state.ownFactionId);
      state.lastError = null;
    } catch (e) {
      state.lastError = `ally: ${e.message}`;
    }
    if (state.enemyFactionId) {
      try {
        state.enemy = await fetchFactionMembers(state.enemyFactionId);
      } catch (e) {
        state.lastError = `enemy: ${e.message}`;
      }
    } else {
      state.enemy = [];
    }
    render();
  }

  // ---------- UI ----------

  const style = document.createElement('style');
  style.textContent = `
    #twc-panel { position: fixed; top: 80px; right: 12px; width: 300px; z-index: 99999;
      background: #1b1e21; border: 1px solid #333; border-radius: 8px; color: #e6e6e6;
      font-family: Arial, sans-serif; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.5); }
    #twc-header { cursor: move; background: #262a2e; padding: 8px 10px; border-radius: 8px 8px 0 0;
      display: flex; justify-content: space-between; align-items: center; user-select: none; }
    #twc-header b { font-size: 13px; }
    #twc-body { padding: 8px 10px; max-height: 400px; overflow-y: auto; }
    #twc-body.collapsed { display: none; }
    .twc-section-title { font-weight: bold; margin: 8px 0 4px; opacity: .7; text-transform: uppercase; font-size: 10px; }
    .twc-row { display: flex; justify-content: space-between; padding: 3px 4px; border-radius: 4px; margin-bottom: 2px; }
    .twc-row.warn { background: rgba(231,76,60,.25); animation: twc-pulse 1s infinite; }
    .twc-row.ally-warn { background: rgba(46,204,113,.25); animation: twc-pulse 1s infinite; }
    @keyframes twc-pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
    #twc-settings { padding: 8px 10px; border-top: 1px solid #333; }
    #twc-settings input { width: 100%; margin-bottom: 4px; box-sizing: border-box; background: #111; color: #eee; border: 1px solid #333; padding: 4px; }
    #twc-settings button { width: 100%; padding: 4px; cursor: pointer; }
    #twc-toggle { cursor: pointer; }
    .twc-empty { opacity: .5; font-style: italic; }
    #twc-error { color: #e74c3c; font-size: 10px; padding: 4px 10px; }
  `;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'twc-panel';
  panel.innerHTML = `
    <div id="twc-header">
      <b>War Call</b>
      <span id="twc-toggle">${state.collapsed ? '▸' : '▾'}</span>
    </div>
    <div id="twc-body" class="${state.collapsed ? 'collapsed' : ''}">
      <div class="twc-section-title">Enemy — coming out</div>
      <div id="twc-enemy-list"></div>
      <div class="twc-section-title">Ally — you're almost out</div>
      <div id="twc-ally-list"></div>
    </div>
    <div id="twc-error"></div>
    <div id="twc-settings">
      <input id="twc-key" type="password" placeholder="Torn API key" value="${state.apiKey}">
      <input id="twc-own" type="text" placeholder="Own faction ID" value="${state.ownFactionId}">
      <input id="twc-enemy" type="text" placeholder="Enemy faction ID (optional)" value="${state.enemyFactionId}">
      <button id="twc-save">Save</button>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById('twc-save').addEventListener('click', () => {
    state.apiKey = document.getElementById('twc-key').value.trim();
    state.ownFactionId = document.getElementById('twc-own').value.trim();
    state.enemyFactionId = document.getElementById('twc-enemy').value.trim();
    GM_setValue('twc_apiKey', state.apiKey);
    GM_setValue('twc_ownFactionId', state.ownFactionId);
    GM_setValue('twc_enemyFactionId', state.enemyFactionId);
    pollData();
  });

  document.getElementById('twc-toggle').addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    GM_setValue('twc_collapsed', state.collapsed);
    document.getElementById('twc-body').classList.toggle('collapsed', state.collapsed);
    document.getElementById('twc-toggle').textContent = state.collapsed ? '▸' : '▾';
  });

  // Simple drag support on the header
  (function makeDraggable() {
    const header = document.getElementById('twc-header');
    let dragging = false, offX = 0, offY = 0;
    header.addEventListener('mousedown', (e) => {
      dragging = true;
      offX = e.clientX - panel.offsetLeft;
      offY = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = `${e.clientX - offX}px`;
      panel.style.top = `${e.clientY - offY}px`;
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => (dragging = false));
  })();

  function fmtTime(seconds) {
    if (seconds <= 0) return 'now';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function render() {
    const now = Math.floor(Date.now() / 1000);

    const inHospital = (list) =>
      list
        .filter((m) => m.state === 'Hospital' && m.until > now)
        .map((m) => ({ ...m, secondsLeft: m.until - now }))
        .sort((a, b) => a.secondsLeft - b.secondsLeft);

    const enemyList = inHospital(state.enemy);
    const allyList = inHospital(state.ally);

    const enemyEl = document.getElementById('twc-enemy-list');
    const allyEl = document.getElementById('twc-ally-list');

    enemyEl.innerHTML = enemyList.length
      ? enemyList
          .map(
            (m) => `<div class="twc-row ${m.secondsLeft <= WARN_WINDOW_SECONDS ? 'warn' : ''}">
              <span>${m.name} [${m.level}]</span><span>${fmtTime(m.secondsLeft)}</span></div>`
          )
          .join('')
      : `<div class="twc-empty">nobody hospitalized</div>`;

    allyEl.innerHTML = allyList.length
      ? allyList
          .map(
            (m) => `<div class="twc-row ${m.secondsLeft <= WARN_WINDOW_SECONDS ? 'ally-warn' : ''}">
              <span>${m.name}</span><span>${fmtTime(m.secondsLeft)}</span></div>`
          )
          .join('')
      : `<div class="twc-empty">nobody hospitalized</div>`;

    document.getElementById('twc-error').textContent = state.lastError || '';
  }

  // Fast local tick keeps the countdown smooth between actual API polls
  setInterval(render, TICK_MS);
  setInterval(pollData, POLL_INTERVAL_MS);
  pollData();
})();
