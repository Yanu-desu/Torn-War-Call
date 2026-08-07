// ==UserScript==
// @name         Torn War Call Panel
// @namespace    torn-war-call
// @version      2.2.1
// @description  Live in-page war dashboard — state machine, structured debug, notification history, optional Discord alerts
// @author       Yanu [3028844]
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.torn.com
// @connect      discord.com
// @connect      discordapp.com
// @require      https://raw.githubusercontent.com/Yanu-desu/Torn-War-Call/main/modules/state.js
// @require      https://raw.githubusercontent.com/Yanu-desu/Torn-War-Call/main/modules/debug.js
// @require      https://raw.githubusercontent.com/Yanu-desu/Torn-War-Call/main/modules/history.js
// @require      https://raw.githubusercontent.com/Yanu-desu/Torn-War-Call/main/modules/travel.js
// ==/UserScript==

(function () {
  'use strict';

  const BUILD_INFO = {
    version: '2.2.1',
    build: 4,
    releaseDate: '2026-08-07',
    initTime: new Date(),
  };

  const WARN_WINDOW_SECONDS = 60;
  const POLL_INTERVAL_MS = 12000;
  const TICK_MS = 1000;
  const WAR_ENDED_DISPLAY_DAYS = 2;

  const Debug = window.TWC.Debug;
  const State = window.TWC.State;
  const History = window.TWC.History;
  const Travel = window.TWC.Travel;

  // ---------- Persisted config ----------

  const config = {
    apiKey: GM_getValue('twc_apiKey', ''),
    ownFactionId: GM_getValue('twc_ownFactionId', ''),
    enemyFactionId: GM_getValue('twc_enemyFactionId', ''),
    discordEnabled: GM_getValue('twc_discordEnabled', false),
    discordWebhookEnemy: GM_getValue('twc_webhookEnemy', ''),
    discordWebhookAlly: GM_getValue('twc_webhookAlly', ''),
    discordRoleId: GM_getValue('twc_roleId', ''),
    collapsed: GM_getValue('twc_collapsed', false),
  };

  function saveConfig() {
    GM_setValue('twc_apiKey', config.apiKey);
    GM_setValue('twc_ownFactionId', config.ownFactionId);
    GM_setValue('twc_enemyFactionId', config.enemyFactionId);
    GM_setValue('twc_discordEnabled', config.discordEnabled);
    GM_setValue('twc_webhookEnemy', config.discordWebhookEnemy);
    GM_setValue('twc_webhookAlly', config.discordWebhookAlly);
    GM_setValue('twc_roleId', config.discordRoleId);
    History.record('settings_changed', 'Settings saved');
  }

  // Live data, not persisted
  const data = { ally: [], enemy: [], lastError: null, warInfo: null };
  const notifiedEnemy = new Map();
  const notifiedAlly = new Map();

  // ---------- Torn API ----------

  function tornGet(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.torn.com/v2${path}${path.includes('?') ? '&' : '?'}key=${config.apiKey}`,
        onload: (res) => {
          try {
            const parsed = JSON.parse(res.responseText);
            if (parsed.error) return reject(new Error(`${parsed.error.code}: ${parsed.error.error}`));
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error('network error')),
      });
    });
  }

  // Travel isn't reliably exposed on the v2 endpoint yet per Torn's own Swagger
  // notes ("if selections remain unaltered, they default to v1") — hitting v1
  // directly for this one selection instead of guessing at a v2 path.
  function tornGetV1(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.torn.com${path}${path.includes('?') ? '&' : '?'}key=${config.apiKey}`,
        onload: (res) => {
          try {
            const parsed = JSON.parse(res.responseText);
            if (parsed.error) return reject(new Error(`${parsed.error.code}: ${parsed.error.error}`));
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error('network error')),
      });
    });
  }

  async function fetchTravelStatus() {
    const res = await tornGetV1('/user/?selections=travel');
    Travel.update(res.travel, Debug);
  }

  const loggedStates = new Set(['Okay', 'Hospital', 'Jail']);

  async function fetchFactionMembers(factionId) {
    const res = await tornGet(`/faction/${factionId}/members`);
    const members = (res.members || []).map((m) => ({
      id: m.id,
      name: m.name,
      level: m.level,
      state: m.status?.state ?? 'Unknown',
      until: m.status?.until ?? 0,
      description: m.status?.description ?? '',
    }));

    // Instead of guessing the exact spelling/casing Torn uses for "traveling",
    // log every state we haven't already seen, once each, so the real string
    // shows up in Debug regardless of what it actually is.
    for (const m of members) {
      if (!loggedStates.has(m.state)) {
        loggedStates.add(m.state);
        Debug.log(Debug.SEVERITY.INFO, 'tornApi', `New status string seen: "${m.state}" — example: ${JSON.stringify(m)}`);
      }
    }

    return members;
  }

  // Best-effort war classification. NOTE: the "scheduled but not started" shape
  // hasn't been confirmed against a live war-prep window — this falls back to
  // UNKNOWN rather than guess, so verify this block once you actually hit prep.
  async function refreshWarState() {
    if (!config.ownFactionId) {
      State.set(State.STATES.UNKNOWN, {});
      return;
    }
    try {
      const res = await tornGet(`/faction/${config.ownFactionId}/wars`);
      const ranked = res.wars?.ranked;
      const now = Math.floor(Date.now() / 1000);

      if (!ranked) {
        State.set(State.STATES.PEACE, {});
        return;
      }

      const opponent = (ranked.factions || []).find((f) => String(f.id) !== String(config.ownFactionId));
      const us = (ranked.factions || []).find((f) => String(f.id) === String(config.ownFactionId));

      if (ranked.start && ranked.start > now) {
        data.warInfo = { opponent };
        State.set(State.STATES.WAR_PREP, { startsAt: ranked.start, opponent });
      } else if (!ranked.end) {
        data.warInfo = { opponent };
        State.set(State.STATES.ACTIVE_WAR, { opponent });
        config.enemyFactionId = opponent ? String(opponent.id) : config.enemyFactionId;
      } else {
        const daysSinceEnd = (now - ranked.end) / 86400;
        if (daysSinceEnd <= WAR_ENDED_DISPLAY_DAYS) {
          const won = us && opponent && us.score > opponent.score;
          State.set(State.STATES.WAR_ENDED, { won, opponent, endedAt: ranked.end });
        } else {
          State.set(State.STATES.PEACE, {});
        }
      }
    } catch (e) {
      Debug.log(Debug.SEVERITY.WARNING, 'warDetection', `Could not refresh war state: ${e.message}`);
      // Don't force UNKNOWN on a transient failure if we already had a good state —
      // only drop to unknown if we've never successfully synced.
      if (State.get().state === State.STATES.UNKNOWN) {
        // stay unknown, nothing to do
      }
    }
  }

  // ---------- Discord ----------

  function postDiscord(webhookUrl, body, label) {
    if (!webhookUrl) {
      Debug.log(Debug.SEVERITY.WARNING, 'discord', `Alert skipped: ${label} webhook URL is empty`);
      return;
    }
    GM_xmlhttpRequest({
      method: 'POST',
      url: webhookUrl,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(body),
      onload: (res) => {
        if (res.status < 200 || res.status >= 300) {
          Debug.log(Debug.SEVERITY.ERROR, 'discord', `Webhook returned ${res.status}: ${res.responseText}`);
        } else {
          Debug.log(Debug.SEVERITY.SUCCESS, 'discord', `Posted OK: ${label} (${res.status})`);
          History.record('ping_sent', `Discord alert sent (${label})`);
        }
      },
      onerror: (err) => {
        Debug.log(Debug.SEVERITY.ERROR, 'discord', `Request error: ${JSON.stringify(err)}`);
      },
    });
  }

  function alertEnemy(member, secondsLeft) {
    const mention = config.discordRoleId ? `<@&${config.discordRoleId}>` : '';
    postDiscord(config.discordWebhookEnemy, {
      content: `${mention} Target incoming: **${member.name}**`,
      embeds: [{
        title: `${member.name} [${member.id}] is coming out of hospital`,
        description: `Landing in ~${secondsLeft}s. Level ${member.level}.`,
        url: `https://www.torn.com/profiles.php?XID=${member.id}`,
        color: 0xe74c3c,
      }],
      allowed_mentions: { parse: ['roles'] },
    }, 'enemy');
  }

  function alertAlly(member, secondsLeft) {
    postDiscord(config.discordWebhookAlly, {
      content: `**${member.name}** almost out — heads up.`,
      embeds: [{
        title: `${member.name} — ~${secondsLeft}s left`,
        url: `https://www.torn.com/profiles.php?XID=${member.id}`,
        color: 0x2ecc71,
      }],
    }, 'ally');
  }

  function sendTestAlert() {
    Debug.log(Debug.SEVERITY.INFO, 'discord', 'Manual test alert triggered, bypassing all checks');
    postDiscord(config.discordWebhookEnemy, {
      content: 'War Call test ping (enemy webhook)',
      embeds: [{ title: 'Test alert — enemy webhook', color: 0xe74c3c }],
    }, 'enemy-test');
    postDiscord(config.discordWebhookAlly, {
      content: 'War Call test ping (ally webhook)',
      embeds: [{ title: 'Test alert — ally webhook', color: 0x2ecc71 }],
    }, 'ally-test');
  }

  function checkAlerts(list, side) {
    // Pings only make sense once a war is actually scheduled or active.
    const currentState = State.get().state;
    const pingableStates = [State.STATES.WAR_PREP, State.STATES.ACTIVE_WAR];
    if (!config.discordEnabled || !pingableStates.includes(currentState)) return;

    const now = Math.floor(Date.now() / 1000);
    const notified = side === 'enemy' ? notifiedEnemy : notifiedAlly;

    for (const m of list) {
      const inHospital = m.state === 'Hospital' && m.until > now;
      if (!inHospital) { notified.delete(m.id); continue; }

      const secondsLeft = m.until - now;
      const already = notified.get(m.id) === m.until;
      if (secondsLeft <= WARN_WINDOW_SECONDS && !already) {
        notified.set(m.id, m.until);
        side === 'enemy' ? alertEnemy(m, secondsLeft) : alertAlly(m, secondsLeft);
      }
    }
  }

  // ---------- Poll ----------

  async function pollData() {
    if (!config.apiKey || !config.ownFactionId) return;

    await refreshWarState();

    try {
      await fetchTravelStatus();
    } catch (e) {
      Debug.log(Debug.SEVERITY.WARNING, 'travel', `Could not refresh travel status: ${e.message}`);
    }

    try {
      data.ally = await fetchFactionMembers(config.ownFactionId);
      data.lastError = null;
      checkAlerts(data.ally, 'ally');
    } catch (e) {
      data.lastError = `ally: ${e.message}`;
      Debug.log(Debug.SEVERITY.ERROR, 'tornApi', data.lastError);
    }

    if (config.enemyFactionId) {
      try {
        data.enemy = await fetchFactionMembers(config.enemyFactionId);
        checkAlerts(data.enemy, 'enemy');
      } catch (e) {
        data.lastError = `enemy: ${e.message}`;
        Debug.log(Debug.SEVERITY.ERROR, 'tornApi', data.lastError);
      }
    } else {
      data.enemy = [];
    }

    render();
  }

  // ---------- Icons (inline SVG, consistent style, no emoji) ----------

  const ICONS = {
    gear: `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 000-2l2.1-1.6a.5.5 0 00.1-.7l-2-3.5a.5.5 0 00-.6-.2l-2.5 1a7.8 7.8 0 00-1.7-1L14.4 2a.5.5 0 00-.5-.4h-4a.5.5 0 00-.5.4l-.4 2.6a7.8 7.8 0 00-1.7 1l-2.5-1a.5.5 0 00-.6.2l-2 3.5a.5.5 0 00.1.7L4.6 11a7.6 7.6 0 000 2l-2.1 1.6a.5.5 0 00-.1.7l2 3.5a.5.5 0 00.6.2l2.5-1c.5.4 1.1.7 1.7 1l.4 2.6a.5.5 0 00.5.4h4a.5.5 0 00.5-.4l.4-2.6a7.8 7.8 0 001.7-1l2.5 1a.5.5 0 00.6-.2l2-3.5a.5.5 0 00-.1-.7L19.4 13zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/></svg>`,
    wrench: `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9a7 7 0 00-8.4-1.2L8 6l-2 2-4.2-4.2A7 7 0 003 11.9c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1a1 1 0 001.4 0l2.3-2.3a1 1 0 000-1.2z"/></svg>`,
    chevronDown: `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>`,
    chevronRight: `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 17l5-5-5-5z"/></svg>`,
    close: `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg>`,
    history: `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M13 3a9 9 0 00-9 9H1l4 4 4-4H6a7 7 0 117 7v2a9 9 0 000-18zm-1 5v5l4 2 .8-1.3-3.3-2V8z"/></svg>`,
  };

  // ---------- Styles ----------

  const style = document.createElement('style');
  style.textContent = `
    #twc-panel, #twc-settings-modal, #twc-debug-modal, #twc-history-modal {
      font-family: 'Consolas', 'Courier New', monospace; color: #baf9ff;
    }
    #twc-panel {
      position: fixed; top: 80px; right: 12px; width: 310px; z-index: 99999;
      background: linear-gradient(180deg, #0b0e14 0%, #0a0c10 100%);
      border: 1px solid #00eaff; border-radius: 4px;
      box-shadow: 0 0 10px rgba(0,234,255,.35), 0 0 30px rgba(255,0,200,.08), inset 0 0 20px rgba(0,234,255,.03);
    }
    #twc-header {
      cursor: move; padding: 8px 10px; user-select: none;
      display: flex; justify-content: space-between; align-items: center;
      border-bottom: 1px solid rgba(0,234,255,.3); background: rgba(0,234,255,.04);
    }
    #twc-header b { font-size: 13px; letter-spacing: 1px; text-transform: uppercase; color: #ff2ec4; text-shadow: 0 0 6px rgba(255,46,196,.7); }
    .twc-icon-btn { cursor: pointer; color: #00eaff; opacity: .8; margin-left: 8px; display: inline-flex; align-items: center; transition: opacity .15s, filter .15s; }
    .twc-icon-btn:hover { opacity: 1; filter: drop-shadow(0 0 4px #00eaff); }

    #twc-status { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 10px;
      letter-spacing: .5px; text-transform: uppercase; border-bottom: 1px solid rgba(0,234,255,.15); cursor: default; }
    #twc-status .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    #twc-status.clickable { cursor: pointer; }
    #twc-status.clickable:hover { background: rgba(255,46,196,.08); }

    #twc-travel { padding: 6px 10px; font-size: 11px; border-bottom: 1px solid rgba(0,234,255,.1); }
    #twc-travel.empty { display: none; }
    .twc-travel-primary { font-weight: bold; }
    .twc-travel-secondary { opacity: .6; font-size: 10px; margin-top: 2px; }
    .twc-travel-departed .twc-travel-primary { color: #7fdfff; }
    .twc-travel-abroad .twc-travel-primary { color: #ffd166; }
    .twc-travel-returning .twc-travel-primary { color: #39ff8a; }

    #twc-body { padding: 8px 10px; max-height: 380px; overflow-y: auto; font-size: 12px; }
    #twc-body.collapsed { display: none; }
    .twc-section-title { font-weight: bold; margin: 8px 0 4px; font-size: 10px; letter-spacing: 1px; color: #ff2ec4; text-transform: uppercase; opacity: .85; }
    .twc-row { display: flex; justify-content: space-between; padding: 4px 6px; margin-bottom: 3px; border: 1px solid rgba(0,234,255,.15); border-radius: 3px; background: rgba(0,234,255,.03); }
    .twc-row.warn { border-color: #ff2ec4; background: rgba(255,46,196,.12); animation: twc-pulse 1s infinite; box-shadow: 0 0 8px rgba(255,46,196,.4); }
    .twc-row.ally-warn { border-color: #39ff8a; background: rgba(57,255,138,.1); animation: twc-pulse 1s infinite; box-shadow: 0 0 8px rgba(57,255,138,.35); }
    @keyframes twc-pulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
    .twc-empty { opacity: .4; font-style: italic; }
    #twc-error { color: #ff2ec4; font-size: 10px; padding: 4px 10px; }
    #twc-version { font-size: 9px; opacity: .4; padding: 4px 10px 8px; border-top: 1px solid rgba(0,234,255,.1); }

    .twc-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 340px; z-index: 100000;
      background: linear-gradient(180deg, #0b0e14 0%, #0a0c10 100%); border-radius: 4px; display: none; }
    .twc-modal.open { display: block; }
    #twc-settings-modal { border: 1px solid #ff2ec4; box-shadow: 0 0 14px rgba(255,46,196,.4), 0 0 40px rgba(0,234,255,.1); }
    #twc-debug-modal { border: 1px solid #39ff8a; box-shadow: 0 0 14px rgba(57,255,138,.4); width: 400px; }
    #twc-history-modal { border: 1px solid #00eaff; box-shadow: 0 0 14px rgba(0,234,255,.4); }

    .twc-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.1); }
    .twc-modal-header b { font-size: 12px; letter-spacing: 1px; text-transform: uppercase; }
    .twc-modal-body { padding: 10px; max-height: 65vh; overflow-y: auto; font-size: 11px; }

    .twc-field-label { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; opacity: .7; margin: 8px 0 3px; }
    .twc-modal input[type=text], .twc-modal input[type=password] {
      width: 100%; box-sizing: border-box; background: #05070a; color: #baf9ff;
      border: 1px solid rgba(0,234,255,.4); border-radius: 3px; padding: 5px 6px; font-family: inherit; font-size: 12px;
      filter: blur(5px); transition: filter .18s ease;
    }
    .twc-modal input[type=text]:hover, .twc-modal input[type=text]:focus,
    .twc-modal input[type=password]:hover, .twc-modal input[type=password]:focus { filter: blur(0); }
    .twc-modal input:focus { outline: none; border-color: #ff2ec4; }
    .twc-checkbox-row { display: flex; align-items: center; gap: 6px; margin: 10px 0 4px; font-size: 11px; }
    .twc-modal button { padding: 7px; margin-top: 8px; cursor: pointer; background: rgba(0,234,255,.08); color: #00eaff;
      border: 1px solid #00eaff; border-radius: 3px; font-family: inherit; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
    .twc-modal button:hover { background: rgba(0,234,255,.18); }
    .twc-btn-row { display: flex; gap: 6px; }
    .twc-btn-row button { flex: 1; }

    #twc-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 99998; display: none; }
    #twc-backdrop.open { display: block; }

    #twc-debug-filters { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
    #twc-debug-filters button { flex: none; padding: 3px 7px; font-size: 9px; margin-top: 0; }
    #twc-debug-filters button.active { background: rgba(57,255,138,.25); }
    #twc-debug-search { width: 100%; box-sizing: border-box; margin-bottom: 8px; background: #05070a; color: #baf9ff;
      border: 1px solid rgba(57,255,138,.3); border-radius: 3px; padding: 5px 6px; font-family: inherit; font-size: 11px; }
    .twc-log-line { padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,.05); display: flex; gap: 6px; }
    .twc-log-time { color: #6c7a89; flex-shrink: 0; }
    .twc-log-source { opacity: .6; flex-shrink: 0; }
    .twc-log-line.info .twc-log-badge { color: #7fdfff; }
    .twc-log-line.success .twc-log-badge { color: #39ff8a; }
    .twc-log-line.warning .twc-log-badge { color: #ffd166; }
    .twc-log-line.error .twc-log-badge { color: #ff2ec4; }
    .twc-log-line.critical .twc-log-badge { color: #ff0033; font-weight: bold; }
    .twc-log-badge { flex-shrink: 0; text-transform: uppercase; font-size: 9px; }

    .twc-history-line { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,.05); font-size: 11px; }
    .twc-history-line .twc-log-time { margin-right: 6px; }
  `;
  document.head.appendChild(style);

  // ---------- Status header config (state -> visual) ----------

  const STATUS_DISPLAY = {
    [State.STATES.UNKNOWN]: { label: 'Syncing…', color: '#6c7a89' },
    [State.STATES.PEACE]: { label: 'At Peace', color: '#7fdfff' },
    [State.STATES.WAR_PREP]: { label: 'War Preparation', color: '#ffd166' },
    [State.STATES.ACTIVE_WAR]: { label: 'Active War', color: '#ff2ec4' },
    [State.STATES.WAR_ENDED]: { label: 'War Ended', color: '#39ff8a' },
    [State.STATES.FAILURE]: { label: 'Script Failure', color: '#ff0033' },
  };

  // ---------- Main panel DOM ----------

  const panel = document.createElement('div');
  panel.id = 'twc-panel';
  panel.innerHTML = `
    <div id="twc-header">
      <b>War Call</b>
      <span>
        <span id="twc-history-btn" class="twc-icon-btn" title="History">${ICONS.history}</span>
        <span id="twc-gear" class="twc-icon-btn" title="Settings">${ICONS.gear}</span>
        <span id="twc-debug-btn" class="twc-icon-btn" title="Debug">${ICONS.wrench}</span>
        <span id="twc-toggle" class="twc-icon-btn">${config.collapsed ? ICONS.chevronRight : ICONS.chevronDown}</span>
      </span>
    </div>
    <div id="twc-status"><span class="dot"></span><span id="twc-status-label"></span></div>
    <div id="twc-travel"></div>
    <div id="twc-body" class="${config.collapsed ? 'collapsed' : ''}">
      <div class="twc-section-title">Enemy — coming out</div>
      <div id="twc-enemy-list"></div>
      <div class="twc-section-title">Enemy — traveling</div>
      <div id="twc-enemy-traveling-list"></div>
      <div class="twc-section-title">Ally — you're almost out</div>
      <div id="twc-ally-list"></div>
      <div class="twc-section-title">Ally — traveling</div>
      <div id="twc-ally-traveling-list"></div>
    </div>
    <div id="twc-error"></div>
    <div id="twc-version"></div>
  `;
  document.body.appendChild(panel);

  const backdrop = document.createElement('div');
  backdrop.id = 'twc-backdrop';
  document.body.appendChild(backdrop);

  // ---------- Settings modal ----------

  const settingsModal = document.createElement('div');
  settingsModal.id = 'twc-settings-modal';
  settingsModal.className = 'twc-modal';
  settingsModal.innerHTML = `
    <div class="twc-modal-header"><b>Settings</b><span id="twc-settings-close" class="twc-icon-btn">${ICONS.close}</span></div>
    <div class="twc-modal-body">
      <div class="twc-section-title">Torn API</div>
      <div class="twc-field-label">API Key</div>
      <input id="twc-key" type="password" value="${config.apiKey}">
      <div class="twc-field-label">Own Faction ID</div>
      <input id="twc-own" type="text" value="${config.ownFactionId}">
      <div class="twc-field-label">Enemy Faction ID (auto-detected during war)</div>
      <input id="twc-enemy" type="text" value="${config.enemyFactionId}">

      <div class="twc-section-title">Discord</div>
      <div class="twc-checkbox-row">
        <input id="twc-discord-enabled" type="checkbox" ${config.discordEnabled ? 'checked' : ''}>
        <label for="twc-discord-enabled">Send Discord alerts from this panel</label>
      </div>
      <div class="twc-field-label">Enemy Webhook URL</div>
      <input id="twc-webhook-enemy" type="password" value="${config.discordWebhookEnemy}">
      <div class="twc-field-label">Ally Webhook URL</div>
      <input id="twc-webhook-ally" type="password" value="${config.discordWebhookAlly}">
      <div class="twc-field-label">Role ID to ping (optional)</div>
      <input id="twc-role-id" type="text" value="${config.discordRoleId}">
      <button id="twc-save">Save</button>
    </div>
  `;
  document.body.appendChild(settingsModal);

  // ---------- Debug modal ----------

  const debugModal = document.createElement('div');
  debugModal.id = 'twc-debug-modal';
  debugModal.className = 'twc-modal';
  debugModal.innerHTML = `
    <div class="twc-modal-header"><b>${ICONS.wrench} Debug</b><span id="twc-debug-close" class="twc-icon-btn">${ICONS.close}</span></div>
    <div class="twc-modal-body">
      <div class="twc-btn-row">
        <button id="twc-debug-poll">Force Poll Now</button>
        <button id="twc-debug-test">Send Test Alert</button>
      </div>
      <input id="twc-debug-search" type="text" placeholder="Search logs...">
      <div id="twc-debug-filters"></div>
      <div id="twc-debug-log"></div>
    </div>
  `;
  document.body.appendChild(debugModal);

  // ---------- History modal ----------

  const historyModal = document.createElement('div');
  historyModal.id = 'twc-history-modal';
  historyModal.className = 'twc-modal';
  historyModal.innerHTML = `
    <div class="twc-modal-header"><b>${ICONS.history} History</b><span id="twc-history-close" class="twc-icon-btn">${ICONS.close}</span></div>
    <div class="twc-modal-body"><div id="twc-history-log"></div></div>
  `;
  document.body.appendChild(historyModal);

  // ---------- Modal open/close plumbing ----------

  const modals = [settingsModal, debugModal, historyModal];
  function closeAllModals() {
    modals.forEach((m) => m.classList.remove('open'));
    backdrop.classList.remove('open');
  }
  function openModal(modal) {
    closeAllModals();
    modal.classList.add('open');
    backdrop.classList.add('open');
  }
  backdrop.addEventListener('click', closeAllModals);

  document.getElementById('twc-gear').addEventListener('click', () => openModal(settingsModal));
  document.getElementById('twc-settings-close').addEventListener('click', closeAllModals);
  document.getElementById('twc-debug-btn').addEventListener('click', () => { openModal(debugModal); renderDebugLog(); });
  document.getElementById('twc-debug-close').addEventListener('click', closeAllModals);
  document.getElementById('twc-history-btn').addEventListener('click', () => { openModal(historyModal); renderHistoryLog(); });
  document.getElementById('twc-history-close').addEventListener('click', closeAllModals);

  document.getElementById('twc-save').addEventListener('click', () => {
    config.apiKey = document.getElementById('twc-key').value.trim();
    config.ownFactionId = document.getElementById('twc-own').value.trim();
    config.enemyFactionId = document.getElementById('twc-enemy').value.trim();
    config.discordEnabled = document.getElementById('twc-discord-enabled').checked;
    config.discordWebhookEnemy = document.getElementById('twc-webhook-enemy').value.trim();
    config.discordWebhookAlly = document.getElementById('twc-webhook-ally').value.trim();
    config.discordRoleId = document.getElementById('twc-role-id').value.trim();
    saveConfig();
    closeAllModals();
    pollData();
  });

  document.getElementById('twc-debug-poll').addEventListener('click', () => {
    Debug.log(Debug.SEVERITY.INFO, 'ui', 'Manual poll triggered from debug panel');
    pollData();
  });
  document.getElementById('twc-debug-test').addEventListener('click', sendTestAlert);

  document.getElementById('twc-toggle').addEventListener('click', () => {
    config.collapsed = !config.collapsed;
    GM_setValue('twc_collapsed', config.collapsed);
    document.getElementById('twc-body').classList.toggle('collapsed', config.collapsed);
    document.getElementById('twc-toggle').innerHTML = config.collapsed ? ICONS.chevronRight : ICONS.chevronDown;
  });

  document.getElementById('twc-status').addEventListener('click', () => {
    if (State.get().state === State.STATES.FAILURE) {
      openModal(debugModal);
      debugFilterState.severity = Debug.SEVERITY.CRITICAL;
      renderDebugLog();
    }
  });

  // Drag support on the header only
  (function makeDraggable() {
    const header = document.getElementById('twc-header');
    let dragging = false, offX = 0, offY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.twc-icon-btn')) return;
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

  // ---------- Debug panel rendering ----------

  const debugFilterState = { severity: null, search: '' };

  function renderDebugFilters() {
    const el = document.getElementById('twc-debug-filters');
    const all = [{ key: null, label: 'All' }].concat(
      Debug.SEVERITY_ORDER.map((s) => ({ key: s, label: s }))
    );
    el.innerHTML = all.map((f) =>
      `<button data-sev="${f.key ?? ''}" class="${debugFilterState.severity === f.key ? 'active' : ''}">${f.label}</button>`
    ).join('');
    el.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        debugFilterState.severity = btn.dataset.sev || null;
        renderDebugLog();
      });
    });
  }

  function renderDebugLog() {
    renderDebugFilters();
    const logEl = document.getElementById('twc-debug-log');
    const entries = Debug.query(debugFilterState);
    logEl.innerHTML = entries.length
      ? entries.map((e) => `<div class="twc-log-line ${e.severity}">
          <span class="twc-log-time">${e.time.toLocaleTimeString()}</span>
          <span class="twc-log-badge">${e.severity}</span>
          <span class="twc-log-source">${e.source}</span>
          <span>${e.message}</span>
        </div>`).join('')
      : `<div class="twc-empty">no logs match</div>`;
  }

  document.getElementById('twc-debug-search').addEventListener('input', (e) => {
    debugFilterState.search = e.target.value;
    renderDebugLog();
  });

  Debug.onLog(() => { if (debugModal.classList.contains('open')) renderDebugLog(); });

  // ---------- History panel rendering ----------

  function renderHistoryLog() {
    const el = document.getElementById('twc-history-log');
    const entries = History.all();
    el.innerHTML = entries.length
      ? entries.map((e) => `<div class="twc-history-line">
          <span class="twc-log-time">${e.time.toLocaleTimeString()}</span>${e.message}</div>`).join('')
      : `<div class="twc-empty">no events yet</div>`;
  }

  History.onRecord(() => { if (historyModal.classList.contains('open')) renderHistoryLog(); });

  // ---------- Status header rendering ----------

  function renderStatus() {
    const { state: s, context } = State.get();
    const display = STATUS_DISPLAY[s] || STATUS_DISPLAY[State.STATES.UNKNOWN];
    const statusEl = document.getElementById('twc-status');
    const labelEl = document.getElementById('twc-status-label');
    const dotEl = statusEl.querySelector('.dot');

    let label = display.label;
    if (s === State.STATES.WAR_ENDED) {
      label = context.won ? 'War Ended — Victory!' : 'War Ended — Fight on';
    }

    labelEl.textContent = label;
    dotEl.style.background = display.color;
    dotEl.style.boxShadow = `0 0 6px ${display.color}`;
    statusEl.style.color = display.color;
    statusEl.classList.toggle('clickable', s === State.STATES.FAILURE);
  }

  State.subscribe((newState, ctx) => {
    renderStatus();
    History.record('state_change', `State changed to ${newState}`);
  });

  Travel.onChange((t) => {
    const labels = {
      [Travel.PHASES.NONE]: 'Landed / not traveling',
      [Travel.PHASES.DEPARTED]: `Travel started to ${t.destination}`,
      [Travel.PHASES.ABROAD]: `Arrived abroad in ${t.destination}`,
      [Travel.PHASES.RETURNING]: 'Return trip started',
      [Travel.PHASES.ARRIVED]: 'Arrived back in Torn',
    };
    History.record('travel_change', labels[t.phase] || `Travel phase: ${t.phase}`);
    renderTravel();
  });

  function fmtClock(unixTs) {
    return new Date(unixTs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderTravel() {
    const el = document.getElementById('twc-travel');
    const t = Travel.get();

    if (t.phase === Travel.PHASES.NONE || t.phase === Travel.PHASES.ARRIVED) {
      el.className = 'empty';
      el.innerHTML = '';
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const secondsLeft = t.arrivalTs ? Math.max(0, t.arrivalTs - now) : 0;

    if (t.phase === Travel.PHASES.DEPARTED) {
      // Outbound: we don't know the return ETA yet, so arrival-abroad is primary here.
      el.className = 'twc-travel-departed';
      el.innerHTML = `
        <div class="twc-travel-primary">[OUTBOUND] ${t.destination} — ${fmtTime(secondsLeft)}</div>
        <div class="twc-travel-secondary">Arriving abroad ~${fmtClock(t.arrivalTs)}</div>`;
    } else if (t.phase === Travel.PHASES.ABROAD) {
      el.className = 'twc-travel-abroad';
      el.innerHTML = `
        <div class="twc-travel-primary">[ABROAD] ${t.destination}</div>
        <div class="twc-travel-secondary">No return timer until you start heading back</div>`;
    } else if (t.phase === Travel.PHASES.RETURNING) {
      // Return leg: this IS the number that matters for faction planning.
      el.className = 'twc-travel-returning';
      el.innerHTML = `
        <div class="twc-travel-primary">[RETURNING] Back in Torn — ${fmtTime(secondsLeft)}</div>
        <div class="twc-travel-secondary">ETA ${fmtClock(t.arrivalTs)}</div>`;
    }
  }

  // ---------- Main list rendering ----------

  function fmtTime(seconds) {
    if (seconds <= 0) return 'now';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function render() {
    const now = Math.floor(Date.now() / 1000);

    const filterByStatus = (list, status) =>
      list.filter((m) => m.state === status && m.until > now)
        .map((m) => ({ ...m, secondsLeft: m.until - now }))
        .sort((a, b) => a.secondsLeft - b.secondsLeft);

    // Don't hardcode one exact spelling — match anything that looks like a
    // travel state. Also don't require until>now: Torn may not expose an
    // exact arrival timestamp for other players (privacy), so someone can be
    // genuinely traveling with until=0 — show them with an unknown ETA rather
    // than silently dropping them.
    const filterTraveling = (list) =>
      list.filter((m) => /travel/i.test(m.state))
        .map((m) => ({ ...m, secondsLeft: m.until > now ? m.until - now : null }))
        .sort((a, b) => (a.secondsLeft ?? Infinity) - (b.secondsLeft ?? Infinity));

    const enemyList = filterByStatus(data.enemy, 'Hospital');
    const allyList = filterByStatus(data.ally, 'Hospital');
    const enemyTraveling = filterTraveling(data.enemy);
    const allyTraveling = filterTraveling(data.ally);

    document.getElementById('twc-enemy-list').innerHTML = enemyList.length
      ? enemyList.map((m) => `<div class="twc-row ${m.secondsLeft <= WARN_WINDOW_SECONDS ? 'warn' : ''}">
          <span>${m.name} [${m.level}]</span><span>${fmtTime(m.secondsLeft)}</span></div>`).join('')
      : `<div class="twc-empty">nobody hospitalized</div>`;

    document.getElementById('twc-ally-list').innerHTML = allyList.length
      ? allyList.map((m) => `<div class="twc-row ${m.secondsLeft <= WARN_WINDOW_SECONDS ? 'ally-warn' : ''}">
          <span>${m.name}</span><span>${fmtTime(m.secondsLeft)}</span></div>`).join('')
      : `<div class="twc-empty">nobody hospitalized</div>`;

    document.getElementById('twc-enemy-traveling-list').innerHTML = enemyTraveling.length
      ? enemyTraveling.map((m) => `<div class="twc-row">
          <span>${m.name} — ${m.description || 'Traveling'}</span><span>${m.secondsLeft === null ? 'ETA unknown' : fmtTime(m.secondsLeft)}</span></div>`).join('')
      : `<div class="twc-empty">nobody traveling</div>`;

    document.getElementById('twc-ally-traveling-list').innerHTML = allyTraveling.length
      ? allyTraveling.map((m) => `<div class="twc-row">
          <span>${m.name} — ${m.description || 'Traveling'}</span><span>${m.secondsLeft === null ? 'ETA unknown' : fmtTime(m.secondsLeft)}</span></div>`).join('')
      : `<div class="twc-empty">nobody traveling</div>`;

    document.getElementById('twc-error').textContent = data.lastError || '';
    document.getElementById('twc-version').textContent =
      `v${BUILD_INFO.version} · build ${BUILD_INFO.build} · ${BUILD_INFO.releaseDate} · init ${BUILD_INFO.initTime.toLocaleTimeString()}`;
  }

  // ---------- Boot ----------

  renderStatus();
  renderTravel();
  render();
  Debug.log(Debug.SEVERITY.SUCCESS, 'init', `War Call panel initialized (v${BUILD_INFO.version})`);
  History.record('script_initialized', `War Call started, v${BUILD_INFO.version}`);

  setInterval(() => { render(); renderTravel(); }, TICK_MS);
  setInterval(pollData, POLL_INTERVAL_MS);
  pollData();
})();
