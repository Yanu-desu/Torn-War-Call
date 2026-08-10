// ==UserScript==
// @name         Torn War Call
// @namespace    https://github.com/Yanu-desu/Torn-War-Call
// @version      6.0.0
// @description  Read-only Torn faction war hospital intel panel with Discord alerts, centralized state machine.
// @author       Yanu [3028844]
// @license      MIT
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.torn.com
// @connect      discord.com
// @connect      discordapp.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /*
     * Torn War Call
     *
     * A read-only intel panel for Torn faction wars. It watches your
     * faction and the enemy faction, shows who's about to leave hospital
     * (with a countdown), tracks your own travel status, and can ping a
     * Discord channel a set number of seconds before someone lands.
     *
     * This script never attacks, clicks, or acts on your behalf — it only
     * reads public/your-own data from the Torn API and displays it. Safe
     * to leave running in the background.
     *
     * New here? Open the panel and click the gear icon first — that's
     * where your API key, faction ID, and Discord webhooks go. Nothing
     * works until that's filled in.
     */

    // =========================================================================
    // MODULE: BuildInfo
    // =========================================================================
    const BuildInfo = {
        version: '6.0.0',
        build: 24,
        releaseDate: '2026-08-08',
        initTime: new Date(),
        notes: 'Final release — all planned features complete.'
    };

    // =========================================================================
    // MODULE: Config (storage keys, load/save)
    // =========================================================================
    const CONFIG_KEYS = {
        USER_CONFIG: 'twc-config',
        HISTORY: 'twc-history',
        UI_PREFS: 'twc-ui-prefs'
    };

    // =========================================================================
    // ⚙ CUSTOMIZE ME — everything you're likely to want to tweak lives here.
    // Nothing below this block should need touching for normal customization.
    // =========================================================================
    //
    //   POLL_INTERVAL_MS      How often (ms) the script checks Torn for war/
    //                         hospital/travel updates. Lower = faster alerts,
    //                         more API calls. 15000 (15s) is a safe default —
    //                         don't go below ~5000 without a reason.
    //
    //   WARNING_SECONDS       How many seconds before hospital release turns
    //                         a player row red in the panel (visual only).
    //                         Ping firing thresholds are now per-slot,
    //                         configured in the Ping Config (🔔) panel —
    //                         this constant no longer controls alerting.
    //
    //   WAR_ENDED_DISPLAY_MS  How long the "War Ended" status (with win/loss
    //                         message) stays shown after a war actually ends,
    //                         before the panel reverts to "At Peace".
    //
    //   PANEL_MIN/MAX_WIDTH,
    //   PANEL_MIN/MAX_HEIGHT  Resize bounds for the panel. Numbers are in
    //                         pixels. Widening these lets the user drag the
    //                         panel bigger/smaller than the defaults.
    //
    //   STATUS_DISPLAY        (further down, in the UI module) — the label
    //                         and color shown for each war state. Edit the
    //                         `label` strings here to change the wording
    //                         without touching any logic.
    //
    //   SEVERITY              (Debug module, below) — the label + color used
    //                         for each log severity level in the debug panel.
    //
    // API key, Faction IDs, and Discord webhook are NOT hardcoded here —
    // they're entered by the user through the in-panel Settings (⚙) modal
    // and persisted to localStorage under CONFIG_KEYS.USER_CONFIG.
    // =========================================================================
    const POLL_INTERVAL_MS = 15000;
    const WARNING_SECONDS = 60;
    const WAR_ENDED_DISPLAY_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
    const PAGE_CHECK_INTERVAL_MS = 4000; // how often to re-check "am I on a faction page" — not usually worth tuning

    const PANEL_MIN_WIDTH = 320;
    const PANEL_MAX_WIDTH = 700;
    const PANEL_MIN_HEIGHT = 220;
    const PANEL_MAX_HEIGHT = 900;

    const ConfigStore = {
        load() {
            try {
                return JSON.parse(localStorage.getItem(CONFIG_KEYS.USER_CONFIG) || '{}');
            } catch {
                return {};
            }
        },
        save(config) {
            localStorage.setItem(CONFIG_KEYS.USER_CONFIG, JSON.stringify(config));
        }
    };

    // UI prefs are kept separate from user config (API keys etc.) — one is
    // "how you use it," the other is "what it's authenticated as." Keeping
    // them apart means resetting layout never risks touching secrets.
    const UIPrefsStore = {
        load() {
            try {
                return JSON.parse(localStorage.getItem(CONFIG_KEYS.UI_PREFS) || '{}');
            } catch {
                return {};
            }
        },
        save(prefs) {
            try {
                localStorage.setItem(CONFIG_KEYS.UI_PREFS, JSON.stringify(prefs));
            } catch (err) {
                console.warn('[War Call] Failed to persist UI prefs:', err);
            }
        }
    };

    const userConfig = ConfigStore.load();

    // One-time migration: earlier versions had a single shared webhook.
    // Copy it into both slots so upgrading doesn't silently kill alerts
    // that were already working — the user can split them apart in
    // Settings whenever they actually want to.
    if (userConfig.discordWebhook && !userConfig.discordWebhookAlly && !userConfig.discordWebhookEnemy) {
        userConfig.discordWebhookAlly = userConfig.discordWebhook;
        userConfig.discordWebhookEnemy = userConfig.discordWebhook;
        delete userConfig.discordWebhook;
        ConfigStore.save(userConfig);
    }
    const uiPrefs = Object.assign(
        { width: 420, height: null, top: 120, right: 20, collapsed: false, hidden: false,
          sectionsCollapsed: { enemy: false, ally: false } },
        UIPrefsStore.load()
    );
    // Backfill in case an older saved prefs blob predates this field.
    uiPrefs.sectionsCollapsed = uiPrefs.sectionsCollapsed || { enemy: false, ally: false };

    function saveUiPrefs() {
        UIPrefsStore.save(uiPrefs);
    }

    // =========================================================================
    // MODULE: EventBus
    // =========================================================================
    const EventBus = (() => {
        const listeners = new Map();
        return {
            on(event, handler) {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(handler);
                return () => listeners.get(event)?.delete(handler);
            },
            emit(event, payload) {
                listeners.get(event)?.forEach((handler) => {
                    try {
                        handler(payload);
                    } catch (err) {
                        Debug.log('critical', 'EventBus', `Listener for "${event}" threw: ${err.message}`);
                    }
                });
            }
        };
    })();

    // =========================================================================
    // MODULE: History
    // =========================================================================
    const History = {
        get() {
            try {
                return JSON.parse(localStorage.getItem(CONFIG_KEYS.HISTORY) || '[]');
            } catch {
                return [];
            }
        },
        add(entry) {
            const items = this.get();
            items.push({ ...entry, timestamp: Math.floor(Date.now() / 1000) });
            const pruned = items.slice(-200);
            try {
                localStorage.setItem(CONFIG_KEYS.HISTORY, JSON.stringify(pruned));
            } catch (err) {
                console.warn('[War Call] Failed to persist history:', err);
            }
        }
    };

    // =========================================================================
    // MODULE: Debug
    // =========================================================================
    // ⚙ CUSTOMIZE: edit `label` for the text shown in the debug panel, or
    // `color` (hex) for its severity tint. `level` controls sort order only —
    // leave it alone unless you're adding a new severity tier.
    const SEVERITY = {
        info: { level: 0, label: 'Info', color: '#7fb3ff' },
        success: { level: 1, label: 'Success', color: '#39ff8a' },
        warn: { level: 2, label: 'Warning', color: '#ffd166' },
        error: { level: 3, label: 'Error', color: '#ff5c5c' },
        critical: { level: 4, label: 'Critical', color: '#ff2ec4' }
    };

    const Debug = {
        entries: [],
        maxEntries: 300,

        log(severity, source, message) {
            const sev = SEVERITY[severity] ? severity : 'info';
            const entry = { severity: sev, source, message, timestamp: Date.now() };
            this.entries.unshift(entry);
            if (this.entries.length > this.maxEntries) this.entries.pop();

            const consoleMethod = sev === 'error' || sev === 'critical' ? 'error' : sev === 'warn' ? 'warn' : 'log';
            console[consoleMethod](`[War Call][${SEVERITY[sev].label}][${source}]`, message);

            History.add({ type: 'log', severity: sev, source, message });
            EventBus.emit('debug:entry', entry);

            if (sev === 'critical') {
                StateMachine.setState(StateMachine.STATES.FAILURE, { reason: message, source });
            }
        }
    };

    // =========================================================================
    // MODULE: StateMachine
    // =========================================================================
    const StateMachine = (() => {
        const STATES = Object.freeze({
            UNKNOWN: 'unknown',
            PEACE: 'peace',
            PREP: 'prep',
            ACTIVE_WAR: 'active_war',
            WAR_ENDED: 'war_ended',
            FAILURE: 'failure'
        });

        let current = STATES.UNKNOWN;
        let meta = {};

        function setState(newState, newMeta = {}) {
            if (!Object.values(STATES).includes(newState)) {
                Debug.log('error', 'StateMachine', `Attempted to set unknown state: ${newState}`);
                return;
            }
            if (current === STATES.FAILURE && newState !== STATES.FAILURE && !newMeta.forceRecover) {
                return;
            }

            const changed = current !== newState;
            const previous = current;
            current = newState;
            meta = newMeta;

            if (changed) {
                Debug.log(
                    newState === STATES.FAILURE ? 'critical' : 'info',
                    'StateMachine',
                    `${previous} -> ${newState}${meta.reason ? ` (${meta.reason})` : ''}`
                );
                History.add({ type: 'state_change', from: previous, to: newState });
                EventBus.emit('state:change', { previous, current: newState, meta });
            }
        }

        function getState() { return current; }
        function getMeta() { return meta; }

        return { STATES, setState, getState, getMeta };
    })();

    // =========================================================================
    // MODULE: TornAPI
    // =========================================================================
    const TornAPI = {
        request(path, params = {}) {
            return this._request('https://api.torn.com', path, params);
        },
        requestV2(path, params = {}) {
            return this._request('https://api.torn.com/v2', path, params);
        },
        _request(base, path, params) {
            return new Promise((resolve, reject) => {
                const apiKey = userConfig.apiKey || localStorage.getItem('twc-api-key');
                if (!apiKey) {
                    reject(new Error('No Torn API key configured.'));
                    return;
                }
                const query = new URLSearchParams({ ...params, key: apiKey });
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `${base}${path}?${query.toString()}`,
                    timeout: 15000,
                    onload(response) {
                        try {
                            const json = JSON.parse(response.responseText);
                            if (json.error) {
                                reject(new Error(`${json.error.code}: ${json.error.error}`));
                                return;
                            }
                            resolve(json);
                        } catch (error) {
                            reject(new Error(`Invalid API response: ${error.message}`));
                        }
                    },
                    onerror() { reject(new Error('Torn API request failed.')); },
                    ontimeout() { reject(new Error('Torn API request timed out.')); }
                });
            });
        }
    };

    // =========================================================================
    // MODULE: Discord
    // =========================================================================
    const Discord = {
        // side: 'ally' | 'enemy' — picks which webhook to use. Falls back to
        // the ally webhook if side is omitted, for any call site that
        // predates the ally/enemy split.
        send(payload, side = 'ally') {
            const webhook = side === 'enemy' ? userConfig.discordWebhookEnemy : userConfig.discordWebhookAlly;
            if (!webhook) {
                Debug.log('warn', 'Discord', `No ${side} webhook configured — alert skipped.`);
                return Promise.resolve();
            }
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: webhook,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify(payload),
                    onload(response) {
                        if (response.status >= 200 && response.status < 300) resolve();
                        else reject(new Error(`Discord returned HTTP ${response.status}`));
                    },
                    onerror() { reject(new Error('Discord webhook request failed.')); }
                });
            });
        }
    };

    // =========================================================================
    // MODULE: Normalize
    // =========================================================================
    function normalizeMember(memberId, member) {
        if (!member) return null;
        const id = Number(member.id || member.player_id || memberId);
        const name = member.name || member.player_name || `Player ${id}`;
        const level = Number(member.level || 0);
        const status = member.status || {};
        const stateName = status.state || member.state || '';
        const until = Number(status.until || member.until || 0);
        const description = status.description || member.description || '';
        return { id, name, level, state: String(stateName), until, description: String(description) };
    }

    function normalizeMembers(response) {
        const members = response?.members || response?.member || {};
        if (Array.isArray(members)) {
            return members.map((m) => normalizeMember(m.id, m)).filter(Boolean);
        }
        return Object.entries(members).map(([id, m]) => normalizeMember(id, m)).filter(Boolean);
    }

    // =========================================================================
    // MODULE: WarDetection (v2 API)
    // =========================================================================
    const WarDetection = {
        async getOwnFactionMembers(ownFactionId) {
            const response = await TornAPI.requestV2(`/faction/${ownFactionId}/members`, {});
            return normalizeMembers(response);
        },
        async getEnemyFactionMembers(enemyFactionId) {
            const response = await TornAPI.requestV2(`/faction/${enemyFactionId}/members`, {});
            return normalizeMembers(response);
        },
        async getRankedWar(ownFactionId) {
            const response = await TornAPI.requestV2(`/faction/${ownFactionId}/wars`, {});
            return response?.wars?.ranked || null;
        },
        derivePhase(rankedWar, now) {
            if (!rankedWar) return { phase: StateMachine.STATES.PEACE };
            const start = Number(rankedWar.start || 0);
            const end = Number(rankedWar.end || 0);

            if (start && now < start) return { phase: StateMachine.STATES.PREP, war: rankedWar };

            if (end && now > end) {
                const endedRecentlyMs = (now - end) * 1000;
                if (endedRecentlyMs > WAR_ENDED_DISPLAY_MS) return { phase: StateMachine.STATES.PEACE };
                return { phase: StateMachine.STATES.WAR_ENDED, war: rankedWar, outcome: this.deriveOutcome(rankedWar) };
            }

            return { phase: StateMachine.STATES.ACTIVE_WAR, war: rankedWar };
        },
        deriveOutcome(rankedWar) {
            const ownId = Number(userConfig.ownFactionId || 0);
            if (rankedWar.winner) return Number(rankedWar.winner) === ownId ? 'won' : 'lost';

            const factions = rankedWar.factions || [];
            if (Array.isArray(factions) && factions.length === 2) {
                const own = factions.find((f) => Number(f.id) === ownId);
                const enemy = factions.find((f) => Number(f.id) !== ownId);
                if (own && enemy) return Number(own.score) >= Number(enemy.score) ? 'won' : 'lost';
            }

            Debug.log('warn', 'WarDetection', 'Could not determine war outcome from available fields — defaulting to "unknown".');
            return 'unknown';
        },
        resolveEnemyFactionId(rankedWar) {
            const pinned = userConfig.enemyFactionId;
            if (pinned) return Number(pinned);
            if (!rankedWar) return null;
            const factions = rankedWar.factions || [];
            const ownId = Number(userConfig.ownFactionId || 0);
            const opponent = factions.find((f) => Number(f.id) !== ownId);
            return opponent ? Number(opponent.id) : null;
        }
    };

    // =========================================================================
    // MODULE: TravelTracker
    // Detects Torn travel status and figures out whether the player is
    // heading out or heading home.
    //
    // Uses the v1 `/user/?selections=travel,basic` endpoint. If Torn ever
    // deprecates this in favor of v2 (like they did with faction data),
    // you'll see error 23 ("only available in API v2") — swap this over
    // to `TornAPI.requestV2()` the same way WarDetection above was fixed.
    //
    // Only shows a direction (Torn -> destination, or destination -> Torn)
    // and a countdown — never a clock time. See formatTime() below.
    // =========================================================================
    const TravelTracker = {
        async fetch() {
            return TornAPI.request('/user/', { selections: 'travel,basic' });
        },

        // Returns null when not traveling, otherwise { phase, destination, arrival }.
        // phase is 'outbound' (heading to destination) or 'returning' (heading home).
        derive(response) {
            const travel = response?.travel || {};
            const status = response?.status || response?.basic?.status || {};

            const stateRaw = String(status.state || '').toLowerCase();
            const isTraveling = stateRaw === 'traveling';
            const destination = travel.destination || '';

            if (!isTraveling || !destination) return null;

            // Torn sets travel.destination to "Torn" itself once you start
            // the return leg — that's the reliable signal for "returning".
            // Description-text matching is kept only as a backup.
            const description = String(status.description || '').toLowerCase();
            const isReturning = destination.toLowerCase() === 'torn' || description.includes('return');
            const phase = isReturning ? 'returning' : 'outbound';
            const arrival = Number(travel.timestamp || travel.time_left_end || status.until || 0);


            return { phase, destination, arrival };
        }
    };

    let travelState = { active: false, phase: null, destination: '', arrival: 0 };
    // Torn sets travel.destination to "Torn" itself during the return leg —
    // this remembers the real origin country so the label can still read
    // "Hawaii -> Torn" instead of the nonsensical "Torn -> Torn".
    let lastKnownDestination = '';

    function updateTravelState(info) {
        if (!info) {
            if (travelState.active) {
                const arrivedHome = travelState.phase === 'returning';
                Debug.log('success', 'Travel', arrivedHome ? 'Arrived back in Torn.' : `Arrived in ${travelState.destination}.`);
                History.add({ type: arrivedHome ? 'arrived_home' : 'arrived_abroad', destination: travelState.destination });
            }
            travelState = { active: false, phase: null, destination: '', arrival: 0 };
            lastKnownDestination = '';
            return;
        }

        if (info.phase === 'outbound') {
            lastKnownDestination = info.destination;
        }
        const displayDestination = info.phase === 'returning' ? (lastKnownDestination || info.destination) : info.destination;

        const changed = travelState.phase !== info.phase || travelState.destination !== displayDestination;
        if (changed) {
            Debug.log(
                'info', 'Travel',
                info.phase === 'outbound'
                    ? `Travel started: Torn -> ${displayDestination}`
                    : `Return travel started: ${displayDestination} -> Torn`
            );
            History.add({
                type: info.phase === 'outbound' ? 'travel_started' : 'return_started',
                destination: displayDestination
            });
        }

        travelState = { active: true, phase: info.phase, destination: displayDestination, arrival: info.arrival };
    }

    // =========================================================================
    // MODULE: Formatting utilities
    // =========================================================================

    // Formats a duration as "1hr 5mins 3secs" — always a countdown, never
    // a clock time. Skips leading zero units (45 seconds shows "45sec",
    // not "0hr 0min 45sec") and pluralizes each unit above 1.
    function formatTime(seconds) {
        seconds = Math.max(0, Math.floor(seconds));

        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        const unit = (value, label) => `${value}${label}${value > 1 ? 's' : ''}`;

        const parts = [];
        if (hrs > 0) parts.push(unit(hrs, 'hr'));
        if (hrs > 0 || mins > 0) parts.push(unit(mins, 'min'));
        parts.push(unit(secs, 'sec'));

        return parts.join(' ');
    }

    function getPlayerUrl(id) {
        return `https://www.torn.com/profiles.php?XID=${encodeURIComponent(id)}`;
    }

    // =========================================================================
    // MODULE: PingSystem
    // Up to 3 configurable ping "slots" per side (ally/enemy) — each with
    // its own countdown threshold, custom message template, and its own
    // enable/disable toggle.
    //
    // Delivery is dual-channel: Discord webhook (if configured) AND an
    // in-panel toast + audio beep, so a ping isn't silently missed if
    // Discord is misconfigured or the person is looking at the panel
    // rather than Discord at the moment it fires.
    //
    // Activation is gated to the state machine, not user-configurable —
    // pings only fire during War Preparation or Active War, and stop the
    // instant the war ends or peace resumes.
    // =========================================================================

    // ⚙ CUSTOMIZE: these are the factory defaults shown the first time
    // someone opens Ping Config — editing them only changes what a *new*
    // install starts with, not anyone's already-saved slots.
    function getDefaultPingSlots() {
        return [
            { id: 1, enabled: true, thresholdSeconds: 60, message: '{name} is leaving hospital in {time}!' },
            { id: 2, enabled: false, thresholdSeconds: 30, message: '{name} — {time} left!' },
            { id: 3, enabled: false, thresholdSeconds: 10, message: 'FINAL WARNING: {name} — {time}!' }
        ];
    }

    function ensurePingSlots(side) {
        const key = side === 'enemy' ? 'pingSlotsEnemy' : 'pingSlotsAlly';
        const defaults = getDefaultPingSlots();

        // One-time migration: earlier versions had one shared slot set for
        // both sides. Copy it into both so upgrading doesn't silently wipe
        // out pings someone already configured and tested.
        if (Array.isArray(userConfig.pingSlots) && !userConfig.pingSlotsAlly && !userConfig.pingSlotsEnemy) {
            userConfig.pingSlotsAlly = userConfig.pingSlots;
            userConfig.pingSlotsEnemy = JSON.parse(JSON.stringify(userConfig.pingSlots));
            delete userConfig.pingSlots;
        }

        if (!Array.isArray(userConfig[key])) {
            userConfig[key] = defaults;
        } else {
            // Backfill any missing slot and hard-cap at 3, regardless of
            // what an older or malformed saved config contains.
            userConfig[key] = defaults
                .map((def, i) => ({ ...def, ...(userConfig[key][i] || {}) }))
                .slice(0, 3);
        }
        return userConfig[key];
    }

    const firedPings = new Set(); // dedup key: `${slotId}:${playerId}:${until}`
    const lastFired = {}; // slotId -> { at: ms, playerName }

    function isPingSystemActive() {
        const s = StateMachine.getState();
        return s === StateMachine.STATES.PREP || s === StateMachine.STATES.ACTIVE_WAR;
    }

    function fillTemplate(template, { name, time, level, side }) {
        return String(template || '{name} — {time}')
            .replace(/\{name\}/g, name)
            .replace(/\{time\}/g, time)
            .replace(/\{level\}/g, String(level ?? '?'))
            .replace(/\{side\}/g, side);
    }

    // Short square-wave beep via Web Audio — no external asset file needed,
    // and it works even if the tab has no other audio permissions granted.
    function playBeep() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = 880;
            gain.gain.value = 0.08;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            setTimeout(() => { osc.stop(); ctx.close(); }, 180);
        } catch (err) {
            Debug.log('warn', 'PingSystem', `Beep playback failed: ${err.message}`);
        }
    }

    // Toasts render in their own fixed container, independent of the main
    // panel — they show even if the panel is collapsed or hidden, since a
    // ping firing is exactly the situation where you're NOT looking at it.
    function showToast(text) {
        let container = document.getElementById('twc-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'twc-toast-container';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        toast.className = 'twc-toast';
        toast.textContent = text;
        container.appendChild(toast);
        setTimeout(() => toast.classList.add('twc-toast-out'), 5000);
        setTimeout(() => toast.remove(), 5600);
    }

    async function firePing(slot, player, side, secondsLeft) {
        const key = `${slot.id}:${player.id}:${player.until}`;
        if (firedPings.has(key)) return;
        firedPings.add(key);

        const time = formatTime(secondsLeft);
        const message = fillTemplate(slot.message, { name: player.name, time, level: player.level, side });

        lastFired[`${side}:${slot.id}`] = { at: Date.now(), playerName: player.name };

        // In-panel delivery always attempted first — it has no dependency
        // on Discord being configured correctly.
        showToast(`[Slot ${slot.id}] ${message}`);
        playBeep();

        History.add({ type: 'ping_sent', slot: slot.id, side, id: player.id, name: player.name, until: player.until });
        Debug.log('success', 'PingSystem', `Slot ${slot.id} fired for ${side} ${player.name}: ${message}`);

        // Discord delivery is best-effort — failure here must not undo the
        // in-panel delivery that already happened above.
        try {
            await Discord.send({
                embeds: [{
                    title: side === 'enemy' ? 'Enemy hospital release' : 'Ally hospital release',
                    description: message,
                    fields: [
                        { name: 'Player', value: `[${player.name}](${getPlayerUrl(player.id)})`, inline: true },
                        { name: 'Level', value: String(player.level || 'Unknown'), inline: true },
                        { name: 'Slot', value: String(slot.id), inline: true }
                    ],
                    timestamp: new Date().toISOString()
                }]
            }, side);
        } catch (error) {
            Debug.log('error', 'PingSystem', `Discord delivery failed for slot ${slot.id}: ${error.message}`);
        }
    }

    function evaluatePings(players, side) {
        if (!isPingSystemActive()) return;
        const enabledSlots = ensurePingSlots(side).filter((s) => s.enabled);
        if (!enabledSlots.length) return;

        const now = Math.floor(Date.now() / 1000);
        for (const player of players) {
            if (!player.until) continue;
            const secondsLeft = player.until - now;
            if (secondsLeft <= 0) continue;

            for (const slot of enabledSlots) {
                if (secondsLeft <= slot.thresholdSeconds) {
                    firePing(slot, player, side, secondsLeft);
                }
            }
        }
    }

    // Drops dedup entries for hospital stays that are no longer current
    // (player left hospital, or their `until` changed), so this Set doesn't
    // grow unbounded across a long session. Called once per poll, separately
    // for each side since ally and enemy now have independent slot configs.
    function pruneFiredPings(allyPlayers, enemyPlayers) {
        const validKeys = new Set();
        for (const slot of ensurePingSlots('ally')) {
            for (const p of allyPlayers) validKeys.add(`${slot.id}:${p.id}:${p.until}`);
        }
        for (const slot of ensurePingSlots('enemy')) {
            for (const p of enemyPlayers) validKeys.add(`${slot.id}:${p.id}:${p.until}`);
        }
        for (const key of firedPings) {
            if (!validKeys.has(key)) firedPings.delete(key);
        }
    }

    // =========================================================================
    // MODULE: Icons
    // =========================================================================
    const Icons = {
        wrench: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a4 4 0 1 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2 2.8-2.8z"/></svg>`,
        gear: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
        collapse: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`,
        expand: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 6 9 12 15 18"/></svg>`,
        eyeOff: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.9 17.9A10.6 10.6 0 0 1 12 20c-7 0-10-8-10-8a18.4 18.4 0 0 1 4.2-5.2M9.9 4.2A10.6 10.6 0 0 1 12 4c7 0 10 8 10 8a18.4 18.4 0 0 1-2.2 3.3M14.1 14.1a3 3 0 1 1-4.2-4.2"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
        eye: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
        bell: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`,
        chevronDown: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`,
        chevronRight: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>`
    };

    // =========================================================================
    // MODULE: Visibility
    // Decides whether the UI should be on screen at all, independent of what
    // the UI renders once it is. Two separate concerns kept apart:
    //   - onFactionPage: automatic, based on URL. Off it, EVERYTHING hides,
    //     including the manual-hide reopen tab, and polling suspends.
    //   - manualHidden: user's own choice via menu command or hide button.
    //     Does not suspend polling — alerts should keep working even if you
    //     don't want the panel cluttering your screen right now.
    // =========================================================================
    const Visibility = (() => {
        function isFactionPage() {
            return window.location.pathname.includes('factions.php');
        }

        let onFactionPage = isFactionPage();

        function checkPageChanged() {
            const nowOnFactionPage = isFactionPage();
            if (nowOnFactionPage !== onFactionPage) {
                onFactionPage = nowOnFactionPage;
                EventBus.emit('visibility:page-changed', { onFactionPage });
            }
        }

        setInterval(checkPageChanged, PAGE_CHECK_INTERVAL_MS);

        return {
            isOnFactionPage: () => onFactionPage,
            isEffectivelyVisible: () => onFactionPage && !uiPrefs.hidden
        };
    })();

    // =========================================================================
    // MODULE: UI
    // =========================================================================
    const data = { ally: [], enemy: [], lastError: '', lastUpdate: 0 };

    // ⚙ CUSTOMIZE: this is the wording/color shown in the status header for
    // each war state. Safe to edit freely — these are display-only, changing
    // them does not affect which state the script thinks it's in.
    const STATUS_DISPLAY = {
        unknown: { label: 'Syncing…', color: '#999' },
        peace: { label: 'At Peace', color: '#7fb3ff' },
        prep: { label: 'War Preparation', color: '#ffd166' },
        active_war: { label: 'Active War', color: '#ff5c5c' },
        war_ended: { label: 'War Ended', color: '#39ff8a' },
        failure: { label: 'Script Failure', color: '#ff2ec4' }
    };

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    let panelEl, reopenTabEl, collapsedTabEl;

    // Performance: render() can run up to once per second during active
    // countdowns. Re-querying the DOM by ID that often is wasted work —
    // these get populated once in createPanel() and reused for the life
    // of the panel instead.
    const els = {};

    function applyPanelGeometry() {
        if (!panelEl) return;
        panelEl.style.top = `${uiPrefs.top}px`;
        panelEl.style.right = `${uiPrefs.right}px`;
        panelEl.style.width = `${uiPrefs.width}px`;
        if (uiPrefs.height) panelEl.style.height = `${uiPrefs.height}px`;
        clampPanelGeometry();
    }

    // Keeps the panel fully on-screen — specifically keeps the bottom-right
    // resize handle and the header drag bar reachable — regardless of drag,
    // resize, or the browser window itself shrinking after a size was saved.
    // Runs after every geometry change, not just once at load, since any of
    // those can independently push the panel off-screen.
    const VIEWPORT_MARGIN = 8;

    function clampPanelGeometry() {
        if (!panelEl) return;

        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const maxW = Math.max(PANEL_MIN_WIDTH, vw - VIEWPORT_MARGIN * 2);
        const maxH = Math.max(PANEL_MIN_HEIGHT, vh - VIEWPORT_MARGIN * 2);

        let width = Math.min(Math.max(uiPrefs.width, PANEL_MIN_WIDTH), Math.min(PANEL_MAX_WIDTH, maxW));
        let height = uiPrefs.height
            ? Math.min(Math.max(uiPrefs.height, PANEL_MIN_HEIGHT), Math.min(PANEL_MAX_HEIGHT, maxH))
            : null;

        // Figure out current left from whichever positioning mode is active
        // (right-anchored by default, left-anchored once the user has dragged it).
        const currentLeft = panelEl.style.left
            ? parseFloat(panelEl.style.left)
            : vw - uiPrefs.right - width;

        const left = Math.min(Math.max(currentLeft, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN));
        const top = Math.min(Math.max(uiPrefs.top, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vh - (height || PANEL_MIN_HEIGHT) - VIEWPORT_MARGIN));

        uiPrefs.width = width;
        if (height) uiPrefs.height = height;
        uiPrefs.top = top;
        uiPrefs.right = vw - (left + width);

        panelEl.style.left = `${left}px`;
        panelEl.style.right = 'auto';
        panelEl.style.top = `${top}px`;
        panelEl.style.width = `${width}px`;
        if (height) panelEl.style.height = `${height}px`;

        saveUiPrefs();
    }

    const FADE_MS = 180;

    // Animates any of the panel's floating elements (main panel, collapsed
    // tab, reopen tab) in/out instead of an instant display:none — this is
    // the "simple animation when interacting" applied consistently rather
    // than as a one-off special case for just the hide button.
    function setElementVisible(el, visible, displayValue = 'flex') {
        if (!el) return;
        if (visible) {
            el.style.display = displayValue;
            void el.offsetWidth; // force reflow so the fade-in actually transitions
            el.classList.remove('twc-fade-hidden');
        } else {
            el.classList.add('twc-fade-hidden');
            setTimeout(() => {
                if (el.classList.contains('twc-fade-hidden')) el.style.display = 'none';
            }, FADE_MS);
        }
    }

    function applyVisibilityToDom() {
        const onFactionPage = Visibility.isOnFactionPage();

        if (!onFactionPage) {
            setElementVisible(panelEl, false);
            setElementVisible(collapsedTabEl, false);
            setElementVisible(reopenTabEl, false);
            return;
        }

        if (uiPrefs.hidden) {
            setElementVisible(panelEl, false);
            setElementVisible(collapsedTabEl, false);
            setElementVisible(reopenTabEl, true);
            return;
        }

        setElementVisible(reopenTabEl, false);

        if (uiPrefs.collapsed) {
            setElementVisible(panelEl, false);
            setElementVisible(collapsedTabEl, true);
        } else {
            setElementVisible(panelEl, true);
            setElementVisible(collapsedTabEl, false);
        }
    }

    function setHidden(hidden) {
        uiPrefs.hidden = hidden;
        saveUiPrefs();
        applyVisibilityToDom();
        Debug.log('info', 'UI', hidden ? 'Panel hidden.' : 'Panel shown.');
    }

    function setCollapsed(collapsed) {
        uiPrefs.collapsed = collapsed;
        saveUiPrefs();
        applyVisibilityToDom();
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #twc-panel {
                position: fixed; z-index: 999999; color: #baf9ff;
                background: linear-gradient(180deg, #0b0e14 0%, #0a0c10 100%);
                border: 1px solid #00eaff; border-radius: 6px;
                box-shadow: 0 0 10px rgba(0,234,255,.35), 0 0 34px rgba(255,0,200,.08), inset 0 0 20px rgba(0,234,255,.03);
                font-family: 'Consolas','Courier New',monospace; font-size: 13px;
                flex-direction: column;
                resize: both; overflow: auto;
                min-width: ${PANEL_MIN_WIDTH}px; max-width: ${PANEL_MAX_WIDTH}px;
                min-height: ${PANEL_MIN_HEIGHT}px; max-height: ${PANEL_MAX_HEIGHT}px;
            }
            #twc-panel * { box-sizing: border-box; }
            #twc-header { padding: 12px; border-bottom: 1px solid rgba(0,234,255,.3); background: rgba(0,234,255,.04);
                font-weight: bold; display: flex; align-items: center; justify-content: space-between; cursor: move;
                user-select: none; flex: 0 0 auto; }
            .twc-title-row { display: flex; align-items: center; gap: 10px; }
            .twc-title-row > span:first-child { color: #ff2ec4; text-shadow: 0 0 6px rgba(255,46,196,.7);
                letter-spacing: 1px; text-transform: uppercase; font-size: 13px; }
            #twc-status { padding: 7px 12px; font-size: 11px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase;
                border-bottom: 1px solid rgba(0,234,255,.2); cursor: default; background: rgba(0,234,255,.02); flex: 0 0 auto; }
            #twc-status.clickable { cursor: pointer; }
            #twc-body-scroll { overflow-y: auto; flex: 1 1 auto; min-height: 0; min-width: 0; }
            #twc-footer { flex: 0 0 auto; padding: 8px 10px; border-top: 1px solid rgba(0,234,255,.2); background: rgba(0,234,255,.02); }
            #twc-travel { flex: 0 0 auto; padding: 8px 12px; border-bottom: 1px solid rgba(0,234,255,.2);
                background: rgba(255,46,196,.05); }
            .twc-travel-route { font-size: 12px; font-weight: bold; letter-spacing: .5px; color: #baf9ff; }
            .twc-travel-eta { font-size: 15px; font-weight: bold; color: #39ff8a; text-shadow: 0 0 6px rgba(57,255,138,.5); margin-top: 2px; }
            .twc-travel-eta.twc-travel-secondary { font-size: 11px; font-weight: normal; color: #6c8a99; text-shadow: none; margin-top: 1px; }
            #twc-version { display: block; margin-top: 4px; color: #5b7480; font-size: 10px; font-weight: normal; letter-spacing: 0; text-transform: none; }
            .twc-section { padding: 10px; border-bottom: 1px solid rgba(0,234,255,.12); }
            .twc-section-title { margin-bottom: 8px; font-weight: bold; font-size: 10px; letter-spacing: 1px;
                text-transform: uppercase; color: #ff2ec4; opacity: .85; }
            .twc-section-toggle { cursor: pointer; display: flex; align-items: center; justify-content: space-between;
                user-select: none; transition: opacity .15s ease; }
            .twc-section-toggle:hover { opacity: 1; }
            .twc-section-chevron { display: inline-flex; transition: transform .18s ease; }
            .twc-section-toggle.twc-section-collapsed .twc-section-chevron { transform: rotate(-90deg); }
            .twc-section-content { overflow: hidden; max-height: 20000px; opacity: 1;
                transition: max-height .22s ease, opacity .18s ease, margin .18s ease; }
            .twc-section-content.twc-section-collapsed { max-height: 0; opacity: 0; margin: 0; }
            .twc-player { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 8px;
                margin-bottom: 4px; border-radius: 3px; background: rgba(0,234,255,.03); border: 1px solid rgba(0,234,255,.15); }
            .twc-player.twc-warning { border-color: #ff2ec4; background: rgba(255,46,196,.12);
                box-shadow: 0 0 8px rgba(255,46,196,.4); animation: twc-pulse 1s infinite; }
            .twc-player-travel { border-color: rgba(127,179,255,.35); background: rgba(127,179,255,.04); }
            @keyframes twc-pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
            .twc-player-name { min-width: 0; flex: 1; }
            .twc-player-name a { color: #baf9ff; text-decoration: none; }
            .twc-player-name a:hover { text-decoration: underline; color: #00eaff; }
            .twc-player-meta { color: #6c8a99; font-size: 11px; text-align: right; }
            .twc-empty { color: #4a5c66; font-style: italic; padding: 4px 0; }
            #twc-error { color: #ff2ec4; white-space: pre-wrap; font-size: 11px; }
            #twc-last-update { color: #5b7480; font-size: 11px; }
            .twc-icon { display: inline-flex; align-items: center; color: #00eaff; opacity: .8; cursor: pointer; transition: opacity .15s, text-shadow .15s; }
            .twc-icon:hover { opacity: 1; text-shadow: 0 0 6px #00eaff; }

            #twc-collapsed-tab { position: fixed; z-index: 999999; display: none; align-items: center; justify-content: center;
                width: 26px; padding: 10px 4px; cursor: pointer; background: linear-gradient(180deg, #0b0e14 0%, #0a0c10 100%);
                border: 1px solid #00eaff; border-right: none; border-radius: 6px 0 0 6px; color: #00eaff;
                box-shadow: 0 0 10px rgba(0,234,255,.3); writing-mode: vertical-rl; text-orientation: mixed;
                font-family: 'Consolas','Courier New',monospace; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; gap: 6px; }
            #twc-collapsed-tab:hover { box-shadow: 0 0 14px rgba(0,234,255,.5); }

            #twc-reopen-tab { position: fixed; bottom: 16px; right: 16px; z-index: 999999; display: none;
                align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 50%;
                background: rgba(11,14,20,.9); border: 1px solid #00eaff; color: #00eaff; cursor: pointer;
                box-shadow: 0 0 10px rgba(0,234,255,.35); }
            #twc-reopen-tab:hover { box-shadow: 0 0 16px rgba(0,234,255,.6); }

            #twc-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 999998;
                opacity: 0; visibility: hidden; transition: opacity .18s ease, visibility 0s linear .18s; }
            #twc-backdrop.open { opacity: 1; visibility: visible; transition: opacity .18s ease, visibility 0s linear 0s; }
            #twc-settings-modal { position: fixed; top: 50%; left: 50%;
                width: 320px; z-index: 999999; color: #baf9ff;
                background: linear-gradient(180deg, #0b0e14 0%, #0a0c10 100%);
                border: 1px solid #ff2ec4; border-radius: 6px;
                box-shadow: 0 0 14px rgba(255,46,196,.4), 0 0 40px rgba(0,234,255,.1);
                font-family: 'Consolas','Courier New',monospace; font-size: 13px;
                opacity: 0; visibility: hidden; pointer-events: none;
                transform: translate(-50%, -50%) scale(.95);
                transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s; }
            #twc-settings-modal.open { opacity: 1; visibility: visible; pointer-events: auto;
                transform: translate(-50%, -50%) scale(1);
                transition: opacity .18s ease, transform .18s ease, visibility 0s linear 0s; }
            #twc-settings-modal * { box-sizing: border-box; }
            #twc-settings-header { display: flex; justify-content: space-between; align-items: center;
                padding: 10px 12px; border-bottom: 1px solid rgba(255,46,196,.3); background: rgba(255,46,196,.05);
                font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: #00eaff; text-shadow: 0 0 6px rgba(0,234,255,.7); font-size: 13px; }
            #twc-settings-close { cursor: pointer; opacity: .7; color: #00eaff; }
            #twc-settings-close:hover { opacity: 1; text-shadow: 0 0 6px #00eaff; }
            #twc-settings-body { padding: 12px; }
            .twc-field-label { font-size: 10px; letter-spacing: .5px; text-transform: uppercase; color: #baf9ff; opacity: .65; margin: 8px 0 3px; }
            #twc-settings-body input { width: 100%; background: #05070a; color: #baf9ff; border: 1px solid rgba(0,234,255,.4);
                border-radius: 3px; padding: 6px; font-family: inherit; font-size: 12px;
                filter: blur(5px); transition: filter .18s ease; }
            #twc-settings-body input:hover, #twc-settings-body input:focus { filter: blur(0); }
            #twc-settings-body input:focus { outline: none; border-color: #ff2ec4; box-shadow: 0 0 6px rgba(255,46,196,.5); }
            #twc-settings-save { width: 100%; margin-top: 12px; padding: 7px; cursor: pointer;
                background: rgba(0,234,255,.08); color: #00eaff; border: 1px solid #00eaff; border-radius: 3px;
                font-family: inherit; font-size: 11px; letter-spacing: 1px; text-transform: uppercase;
                transition: background .15s, box-shadow .15s; }
            #twc-settings-save:hover { background: rgba(0,234,255,.18); box-shadow: 0 0 10px rgba(0,234,255,.4); }
            .twc-settings-divider { border-top: 1px solid rgba(0,234,255,.2); margin: 14px 0 4px; }
            #twc-config-io { display: flex; gap: 6px; }
            #twc-config-io button { flex: 1; padding: 6px; cursor: pointer;
                background: rgba(255,209,102,.08); color: #ffd166; border: 1px solid #ffd166; border-radius: 3px;
                font-family: inherit; font-size: 10px; letter-spacing: .5px; text-transform: uppercase; }
            #twc-config-io button:hover { background: rgba(255,209,102,.18); box-shadow: 0 0 8px rgba(255,209,102,.4); }
            .twc-io-hint { font-size: 9px; color: #6c8a99; margin-top: 6px; line-height: 1.4; }

            #twc-debug-modal { position: fixed; top: 50%; left: 50%;
                width: 460px; max-height: 70vh; display: flex; flex-direction: column;
                z-index: 999999; color: #baf9ff;
                background: linear-gradient(180deg, #0b0e14 0%, #0a0c10 100%);
                border: 1px solid #39ff8a; border-radius: 6px;
                box-shadow: 0 0 14px rgba(57,255,138,.4), 0 0 40px rgba(0,234,255,.1);
                font-family: 'Consolas','Courier New',monospace; font-size: 11px;
                opacity: 0; visibility: hidden; pointer-events: none;
                transform: translate(-50%, -50%) scale(.95);
                transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s; }
            #twc-debug-modal.open { opacity: 1; visibility: visible; pointer-events: auto;
                transform: translate(-50%, -50%) scale(1);
                transition: opacity .18s ease, transform .18s ease, visibility 0s linear 0s; }
            #twc-debug-header { display: flex; justify-content: space-between; align-items: center;
                padding: 10px 12px; border-bottom: 1px solid rgba(57,255,138,.3); background: rgba(57,255,138,.05);
                font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: #39ff8a;
                text-shadow: 0 0 6px rgba(57,255,138,.7); font-size: 12px; flex: 0 0 auto; }
            #twc-debug-close { cursor: pointer; opacity: .7; color: #39ff8a; }
            #twc-debug-close:hover { opacity: 1; text-shadow: 0 0 6px #39ff8a; }
            #twc-debug-state { padding: 8px 12px; border-bottom: 1px solid rgba(57,255,138,.2); line-height: 1.7; flex: 0 0 auto; }
            #twc-debug-state .twc-ok { color: #39ff8a; }
            #twc-debug-state .twc-bad { color: #ff2ec4; }
            #twc-debug-actions { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid rgba(57,255,138,.2); flex: 0 0 auto; }
            #twc-debug-actions button { flex: 1; padding: 6px; cursor: pointer;
                background: rgba(57,255,138,.08); color: #39ff8a; border: 1px solid #39ff8a; border-radius: 3px;
                font-family: inherit; font-size: 10px; letter-spacing: .5px; text-transform: uppercase; }
            #twc-debug-actions button:hover { background: rgba(57,255,138,.18); box-shadow: 0 0 8px rgba(57,255,138,.4); }
            #twc-debug-tabs { display: flex; border-bottom: 1px solid rgba(57,255,138,.2); flex: 0 0 auto; }
            .twc-debug-tab-btn { flex: 1; padding: 7px; cursor: pointer; background: transparent; color: #6c8a99;
                border: none; border-bottom: 2px solid transparent; font-family: inherit; font-size: 10px;
                letter-spacing: 1px; text-transform: uppercase; }
            .twc-debug-tab-btn:hover { color: #baf9ff; }
            .twc-debug-tab-btn.active { color: #39ff8a; border-bottom-color: #39ff8a; }
            .twc-health-row { display: flex; align-items: center; gap: 8px; padding: 5px 2px; border-bottom: 1px solid rgba(255,255,255,.05); }
            .twc-health-icon { width: 16px; text-align: center; font-weight: bold; }
            .twc-health-pass .twc-health-icon { color: #39ff8a; }
            .twc-health-fail .twc-health-icon { color: #ff2ec4; }
            .twc-health-name { width: 140px; flex: 0 0 auto; color: #baf9ff; }
            .twc-health-msg { color: #6c8a99; flex: 1; word-break: break-word; }
            #twc-debug-filters { display: flex; gap: 4px; padding: 6px 12px; flex: 0 0 auto; flex-wrap: wrap; }
            .twc-debug-filter-btn { padding: 3px 8px; cursor: pointer; background: transparent; color: #6c8a99;
                border: 1px solid rgba(108,138,153,.4); border-radius: 10px; font-family: inherit; font-size: 9px;
                text-transform: uppercase; letter-spacing: .5px; }
            .twc-debug-filter-btn.active { background: rgba(0,234,255,.15); color: #00eaff; border-color: #00eaff; }
            .twc-debug-filter-btn:hover { border-color: #00eaff; }
            #twc-debug-body { padding: 8px 10px; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
            .twc-log-line { padding: 4px 2px; border-bottom: 1px solid rgba(255,255,255,.05); display: flex; gap: 6px; flex-wrap: wrap; }
            .twc-log-time { color: #4a5c66; }
            .twc-log-sev { font-weight: bold; text-transform: uppercase; font-size: 9px; padding: 1px 4px; border-radius: 2px; }
            .twc-log-src { color: #7fb3ff; opacity: .8; }
            .twc-log-msg { color: #baf9ff; word-break: break-word; flex-basis: 100%; }
            .twc-log-info .twc-log-sev { background: rgba(127,179,255,.15); color: #7fb3ff; }
            .twc-log-success .twc-log-sev { background: rgba(57,255,138,.15); color: #39ff8a; }
            .twc-log-warn .twc-log-sev { background: rgba(255,209,102,.15); color: #ffd166; }
            .twc-log-error .twc-log-sev { background: rgba(255,92,92,.15); color: #ff5c5c; }
            .twc-log-critical .twc-log-sev { background: rgba(255,46,196,.2); color: #ff2ec4; }

            /* Toasts — deliberately outside the panel entirely, so a ping
               is visible even if the panel is collapsed or hidden. */
            #twc-toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 1000000;
                display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
            .twc-toast { background: linear-gradient(180deg, #0b0e14 0%, #0a0c10 100%);
                border: 1px solid #ff2ec4; border-radius: 6px; padding: 10px 14px; max-width: 320px;
                color: #baf9ff; font-family: 'Consolas','Courier New',monospace; font-size: 12px;
                box-shadow: 0 0 14px rgba(255,46,196,.5); opacity: 1; transition: opacity .6s ease; }
            .twc-toast.twc-toast-out { opacity: 0; }

            #twc-ping-modal { position: fixed; top: 50%; left: 50%;
                width: 560px; max-width: 92vw; max-height: 75vh; display: flex; flex-direction: column;
                z-index: 999999; color: #baf9ff;
                background: linear-gradient(180deg, #0b0e14 0%, #0a0c10 100%);
                border: 1px solid #ffd166; border-radius: 6px;
                box-shadow: 0 0 14px rgba(255,209,102,.4), 0 0 40px rgba(0,234,255,.1);
                font-family: 'Consolas','Courier New',monospace; font-size: 12px;
                opacity: 0; visibility: hidden; pointer-events: none;
                transform: translate(-50%, -50%) scale(.95);
                transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s; }
            #twc-ping-modal.open { opacity: 1; visibility: visible; pointer-events: auto;
                transform: translate(-50%, -50%) scale(1);
                transition: opacity .18s ease, transform .18s ease, visibility 0s linear 0s; }
            #twc-ping-header { display: flex; justify-content: space-between; align-items: center;
                padding: 10px 12px; border-bottom: 1px solid rgba(255,209,102,.3); background: rgba(255,209,102,.05);
                font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: #ffd166;
                text-shadow: 0 0 6px rgba(255,209,102,.7); font-size: 12px; flex: 0 0 auto; }
            #twc-ping-close { cursor: pointer; opacity: .7; color: #ffd166; }
            #twc-ping-close:hover { opacity: 1; text-shadow: 0 0 6px #ffd166; }
            #twc-ping-body { padding: 10px 12px; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
            .twc-ping-hint { font-size: 10px; color: #6c8a99; margin-bottom: 10px; line-height: 1.5; }
            #twc-ping-columns { display: flex; gap: 10px; }
            .twc-ping-column { flex: 1 1 0; min-width: 0; }
            .twc-ping-column-title { font-size: 10px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase;
                margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,209,102,.25); }
            .twc-ping-column-ally { color: #39ff8a; }
            .twc-ping-column-enemy { color: #ff5c5c; }
            .twc-ping-slot { border: 1px solid rgba(255,209,102,.25); border-radius: 4px; padding: 8px; margin-bottom: 10px; }
            .twc-ping-slot-active { border-color: #ffd166; background: rgba(255,209,102,.04); }
            .twc-ping-slot-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
            .twc-ping-toggle { display: flex; align-items: center; gap: 6px; font-weight: bold; font-size: 11px; }
            .twc-ping-status { font-size: 9px; letter-spacing: .5px; color: #6c8a99; }
            .twc-ping-slot-active .twc-ping-status { color: #ffd166; }
            .twc-ping-meta { font-size: 10px; color: #6c8a99; margin-top: 4px; }
            .twc-ping-slot input[type=text] { width: 100%; box-sizing: border-box; background: #05070a; color: #baf9ff;
                border: 1px solid rgba(0,234,255,.4); border-radius: 3px; padding: 5px 6px; font-family: inherit; font-size: 11px; }
            .twc-ping-slot input[type=text]:focus { outline: none; border-color: #ffd166; }
            .twc-ping-test { width: 100%; margin-top: 6px; padding: 5px; cursor: pointer;
                background: rgba(255,209,102,.08); color: #ffd166; border: 1px solid #ffd166; border-radius: 3px;
                font-family: inherit; font-size: 9px; letter-spacing: .5px; text-transform: uppercase; }
            .twc-ping-test:hover { background: rgba(255,209,102,.18); }
            #twc-ping-save { width: 100%; margin-top: 4px; padding: 7px; cursor: pointer;
                background: rgba(0,234,255,.08); color: #00eaff; border: 1px solid #00eaff; border-radius: 3px;
                font-family: inherit; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }
            #twc-ping-save:hover { background: rgba(0,234,255,.18); box-shadow: 0 0 10px rgba(0,234,255,.4); }
        `;
        document.head.appendChild(style);
    }

    function createPanel() {
        if (document.getElementById('twc-panel')) return;

        injectStyles();

        panelEl = document.createElement('div');
        panelEl.id = 'twc-panel';
        panelEl.innerHTML = `
            <div id="twc-header">
                <div class="twc-title-row"><span>Torn War Call</span></div>
                <div class="twc-title-row">
                    <span class="twc-icon" id="twc-settings-btn" title="Settings">${Icons.gear}</span>
                    <span class="twc-icon" id="twc-ping-config-btn" title="Ping Config">${Icons.bell}</span>
                    <span class="twc-icon" id="twc-debug-btn" title="Debug">${Icons.wrench}</span>
                    <span class="twc-icon" id="twc-collapse-btn" title="Collapse">${Icons.collapse}</span>
                    <span class="twc-icon" id="twc-hide-btn" title="Hide">${Icons.eyeOff}</span>
                </div>
            </div>
            <div id="twc-status"></div>
            <div id="twc-travel" style="display:none;"></div>
            <div id="twc-body-scroll">
                <div class="twc-section">
                    <div class="twc-section-title twc-section-toggle" data-section="enemy">
                        <span>Enemy</span>
                        <span class="twc-section-chevron">${Icons.chevronDown}</span>
                    </div>
                    <div id="twc-enemy-list" class="twc-section-content"><div class="twc-empty">Loading...</div></div>
                </div>
                <div class="twc-section">
                    <div class="twc-section-title twc-section-toggle" data-section="ally">
                        <span>Ally</span>
                        <span class="twc-section-chevron">${Icons.chevronDown}</span>
                    </div>
                    <div id="twc-ally-list" class="twc-section-content"><div class="twc-empty">Loading...</div></div>
                </div>
            </div>
            <div id="twc-footer">
                <div id="twc-last-update"></div>
                <div id="twc-error"></div>
                <div id="twc-version"></div>
            </div>
        `;
        document.body.appendChild(panelEl);

        els.status = document.getElementById('twc-status');
        els.travel = document.getElementById('twc-travel');
        els.enemyList = document.getElementById('twc-enemy-list');
        els.allyList = document.getElementById('twc-ally-list');
        els.error = document.getElementById('twc-error');
        els.lastUpdate = document.getElementById('twc-last-update');
        els.version = document.getElementById('twc-version');
        applyPanelGeometry();

        collapsedTabEl = document.createElement('div');
        collapsedTabEl.id = 'twc-collapsed-tab';
        collapsedTabEl.innerHTML = `<span>WAR CALL</span>`;
        collapsedTabEl.style.top = `${uiPrefs.top}px`;
        collapsedTabEl.style.right = '0px';
        document.body.appendChild(collapsedTabEl);
        collapsedTabEl.addEventListener('click', () => setCollapsed(false));

        reopenTabEl = document.createElement('div');
        reopenTabEl.id = 'twc-reopen-tab';
        reopenTabEl.title = 'Show Torn War Call';
        reopenTabEl.innerHTML = Icons.eye;
        document.body.appendChild(reopenTabEl);
        reopenTabEl.addEventListener('click', () => setHidden(false));

        const backdrop = document.createElement('div');
        backdrop.id = 'twc-backdrop';
        document.body.appendChild(backdrop);

        const settingsModal = document.createElement('div');
        settingsModal.id = 'twc-settings-modal';
        settingsModal.innerHTML = `
            <div id="twc-settings-header">
                <span>Settings</span>
                <span id="twc-settings-close">✕</span>
            </div>
            <div id="twc-settings-body">
                <div class="twc-field-label">Torn API Key</div>
                <input id="twc-input-apikey" type="password" value="${escapeHtml(userConfig.apiKey || '')}">
                <div class="twc-field-label">Own Faction ID</div>
                <input id="twc-input-ownfaction" type="text" value="${escapeHtml(userConfig.ownFactionId || '')}">
                <div class="twc-field-label">Enemy Faction ID (optional pin)</div>
                <input id="twc-input-enemyfaction" type="text" value="${escapeHtml(userConfig.enemyFactionId || '')}">
                <div class="twc-field-label">Ally Discord Webhook URL</div>
                <input id="twc-input-webhook-ally" type="password" value="${escapeHtml(userConfig.discordWebhookAlly || '')}">
                <div class="twc-field-label">Enemy Discord Webhook URL</div>
                <input id="twc-input-webhook-enemy" type="password" value="${escapeHtml(userConfig.discordWebhookEnemy || '')}">
                <button id="twc-settings-save">Save</button>
                <div class="twc-settings-divider"></div>
                <div class="twc-field-label">Backup / Restore</div>
                <div id="twc-config-io">
                    <button id="twc-export-config">Export Config</button>
                    <button id="twc-import-config">Import Config</button>
                    <input type="file" id="twc-import-file" accept="application/json" style="display:none;">
                </div>
                <div class="twc-io-hint">Exports include your API key and webhook URLs in plain text — treat the file like a password.</div>
            </div>
        `;
        document.body.appendChild(settingsModal);

        const pingModal = document.createElement('div');
        pingModal.id = 'twc-ping-modal';
        pingModal.innerHTML = `
            <div id="twc-ping-header">
                <span>Ping Config</span>
                <span id="twc-ping-close">✕</span>
            </div>
            <div id="twc-ping-body">
                <div class="twc-ping-hint">
                    Up to 3 slots per side. Each fires independently once its countdown threshold is
                    crossed. Placeholders: {name} {time} {level} {side}.
                    Pings only fire during War Preparation or Active War.
                </div>
                <div id="twc-ping-columns">
                    <div class="twc-ping-column">
                        <div class="twc-ping-column-title twc-ping-column-ally">Ally</div>
                        <div id="twc-ping-slots-ally"></div>
                    </div>
                    <div class="twc-ping-column">
                        <div class="twc-ping-column-title twc-ping-column-enemy">Enemy</div>
                        <div id="twc-ping-slots-enemy"></div>
                    </div>
                </div>
                <button id="twc-ping-save">Save Both</button>
            </div>
        `;
        document.body.appendChild(pingModal);

        function renderPingSlotEditor(side) {
            const container = document.getElementById(side === 'enemy' ? 'twc-ping-slots-enemy' : 'twc-ping-slots-ally');
            if (!container) return;
            const slots = ensurePingSlots(side);

            container.innerHTML = slots
                .map((slot) => {
                    const fired = lastFired[`${side}:${slot.id}`];
                    const firedText = fired ? `Last fired: ${fired.playerName}, ${formatTime(Math.round((Date.now() - fired.at) / 1000))} ago` : 'Not fired yet this session';
                    return `
                        <div class="twc-ping-slot ${slot.enabled ? 'twc-ping-slot-active' : ''}">
                            <div class="twc-ping-slot-row">
                                <label class="twc-ping-toggle">
                                    <input type="checkbox" class="twc-ping-enabled" data-side="${side}" data-slot="${slot.id}" ${slot.enabled ? 'checked' : ''}>
                                    Slot ${slot.id}
                                </label>
                                <span class="twc-ping-status">${slot.enabled ? 'ACTIVE' : 'off'}</span>
                            </div>
                            <div class="twc-field-label">Fire when this many seconds remain</div>
                            <input type="text" inputmode="numeric" class="twc-ping-threshold" data-side="${side}" data-slot="${slot.id}" value="${slot.thresholdSeconds}">
                            <div class="twc-field-label">Message</div>
                            <input type="text" class="twc-ping-message" data-side="${side}" data-slot="${slot.id}" value="${escapeHtml(slot.message)}">
                            <div class="twc-ping-meta">${firedText}</div>
                            <button class="twc-ping-test" data-side="${side}" data-slot="${slot.id}">Test Slot ${slot.id}</button>
                        </div>
                    `;
                })
                .join('');

            container.querySelectorAll('.twc-ping-test').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const testSide = btn.dataset.side;
                    const slotId = Number(btn.dataset.slot);
                    const slot = ensurePingSlots(testSide).find((s) => s.id === slotId);
                    if (!slot) return;
                    // Bypass dedup entirely for a manual test — fake player, fake `until`.
                    const fakePlayer = { id: 0, name: 'Test Player', level: 1, until: Math.floor(Date.now() / 1000) + slot.thresholdSeconds };
                    firedPings.delete(`${slot.id}:0:${fakePlayer.until}`);
                    firePing(slot, fakePlayer, testSide, slot.thresholdSeconds);
                });
            });
        }

        function openPingConfig() {
            renderPingSlotEditor('ally');
            renderPingSlotEditor('enemy');
            pingModal.classList.add('open');
            backdrop.classList.add('open');
        }
        function closePingConfig() {
            pingModal.classList.remove('open');
            backdrop.classList.remove('open');
        }

        document.getElementById('twc-ping-config-btn').addEventListener('click', openPingConfig);
        document.getElementById('twc-ping-close').addEventListener('click', closePingConfig);

        document.getElementById('twc-ping-save').addEventListener('click', () => {
            ['ally', 'enemy'].forEach((side) => {
                const slots = ensurePingSlots(side);
                document.querySelectorAll(`.twc-ping-enabled[data-side="${side}"]`).forEach((el) => {
                    const slot = slots.find((s) => s.id === Number(el.dataset.slot));
                    if (slot) slot.enabled = el.checked;
                });
                document.querySelectorAll(`.twc-ping-threshold[data-side="${side}"]`).forEach((el) => {
                    const slot = slots.find((s) => s.id === Number(el.dataset.slot));
                    if (slot) slot.thresholdSeconds = Math.max(1, Number(el.value) || slot.thresholdSeconds);
                });
                document.querySelectorAll(`.twc-ping-message[data-side="${side}"]`).forEach((el) => {
                    const slot = slots.find((s) => s.id === Number(el.dataset.slot));
                    if (slot) slot.message = el.value.trim() || slot.message;
                });
                userConfig[side === 'enemy' ? 'pingSlotsEnemy' : 'pingSlotsAlly'] = slots;
            });
            ConfigStore.save(userConfig);
            Debug.log('info', 'PingSystem', 'Ping slot configuration saved for both sides.');
            renderPingSlotEditor('ally');
            renderPingSlotEditor('enemy');
            closePingConfig();
        });

        const debugModal = document.createElement('div');
        debugModal.id = 'twc-debug-modal';
        debugModal.innerHTML = `
            <div id="twc-debug-header">
                <span>Debug</span>
                <span id="twc-debug-close">✕</span>
            </div>
            <div id="twc-debug-state"></div>
            <div id="twc-debug-actions">
                <button id="twc-debug-poll">Force Poll Now</button>
                <button id="twc-debug-test">Send Test Alert</button>
                <button id="twc-debug-clear">Clear Log</button>
            </div>
            <div id="twc-debug-tabs">
                <button class="twc-debug-tab-btn" data-tab="log">Log</button>
                <button class="twc-debug-tab-btn" data-tab="history">History</button>
                <button class="twc-debug-tab-btn" data-tab="health">Health</button>
            </div>
            <div id="twc-debug-filters"></div>
            <div id="twc-debug-body"></div>
        `;
        document.body.appendChild(debugModal);

        let debugFilter = null;
        let debugTab = 'log';

        function renderDebugTabs() {
            debugModal.querySelectorAll('.twc-debug-tab-btn').forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.tab === debugTab);
            });
            document.getElementById('twc-debug-filters').style.display = debugTab === 'log' ? 'flex' : 'none';
        }

        // Human-readable formatting per History event type — matches the
        // exact shapes each History.add() call site actually produces.
        function formatHistoryEntry(e) {
            switch (e.type) {
                case 'log': return `[${SEVERITY[e.severity]?.label || e.severity}] ${e.source}: ${e.message}`;
                case 'state_change': return `War state changed: ${e.from} → ${e.to}`;
                case 'travel_started': return `Travel started: Torn → ${e.destination}`;
                case 'return_started': return `Return travel started: ${e.destination} → Torn`;
                case 'arrived_home': return 'Arrived back in Torn';
                case 'arrived_abroad': return `Arrived in ${e.destination}`;
                case 'ping_sent': return `Ping fired — slot ${e.slot} (${e.side}) for ${e.name}`;
                case 'script_initialized': return 'Script initialized';
                default: return e.type;
            }
        }

        function renderHistoryTab() {
            const body = document.getElementById('twc-debug-body');
            if (!body) return;
            const items = History.get().slice().reverse(); // newest first
            if (!items.length) {
                body.innerHTML = `<div class="twc-empty">No history yet.</div>`;
                return;
            }
            body.innerHTML = items
                .map((e) => `
                    <div class="twc-log-line">
                        <span class="twc-log-time">${new Date(e.timestamp * 1000).toLocaleString()}</span>
                        <span class="twc-log-msg">${escapeHtml(formatHistoryEntry(e))}</span>
                    </div>
                `)
                .join('');
        }

        // Health checks — each returns { name, pass, message }. Ally and
        // enemy webhooks are checked separately since one can be working
        // while the other is misconfigured.
        function runHealthChecks() {
            const checks = [];
            checks.push({
                name: 'War detection',
                pass: !data.lastError,
                message: data.lastError || `Current state: ${StateMachine.getState()}`
            });
            checks.push({
                name: 'Faction page detection',
                pass: true,
                message: Visibility.isOnFactionPage() ? 'Currently on a faction page' : 'Not on a faction page (panel hidden by design)'
            });
            checks.push({
                name: 'Poll timer',
                pass: !!pollTimeoutHandle,
                message: pollTimeoutHandle ? 'Running' : 'Not scheduled — this is a real problem'
            });
            let storageOk = false;
            try {
                localStorage.setItem('twc-health-check', '1');
                storageOk = localStorage.getItem('twc-health-check') === '1';
                localStorage.removeItem('twc-health-check');
            } catch (e) { storageOk = false; }
            checks.push({ name: 'Storage', pass: storageOk, message: storageOk ? 'Read/write OK' : 'localStorage unavailable' });
            checks.push({
                name: 'Ping system active',
                pass: isPingSystemActive(),
                message: isPingSystemActive() ? 'Active for current war state' : 'Inactive (only runs during Prep/Active War)'
            });
            checks.push({
                name: 'Ally Discord webhook',
                pass: !!userConfig.discordWebhookAlly,
                message: userConfig.discordWebhookAlly ? 'Configured' : 'Not set in Settings'
            });
            checks.push({
                name: 'Enemy Discord webhook',
                pass: !!userConfig.discordWebhookEnemy,
                message: userConfig.discordWebhookEnemy ? 'Configured' : 'Not set in Settings'
            });
            checks.push({ name: 'UI initialized', pass: !!panelEl && document.body.contains(panelEl), message: panelEl ? 'Panel is in the DOM' : 'Panel missing' });
            checks.push({
                name: 'Config loaded',
                pass: !!(userConfig.apiKey && userConfig.ownFactionId),
                message: (userConfig.apiKey && userConfig.ownFactionId) ? 'API key and Faction ID set' : 'Missing API key or Faction ID'
            });
            checks.push({
                name: 'State sync',
                pass: StateMachine.getState() !== StateMachine.STATES.UNKNOWN,
                message: StateMachine.getState() === StateMachine.STATES.UNKNOWN ? 'Still syncing — normal only right after load' : 'Synced'
            });
            return checks;
        }

        function renderHealthTab() {
            const body = document.getElementById('twc-debug-body');
            if (!body) return;
            const checks = runHealthChecks();
            body.innerHTML = checks
                .map((c) => `
                    <div class="twc-health-row ${c.pass ? 'twc-health-pass' : 'twc-health-fail'}">
                        <span class="twc-health-icon">${c.pass ? '✓' : '✕'}</span>
                        <span class="twc-health-name">${escapeHtml(c.name)}</span>
                        <span class="twc-health-msg">${escapeHtml(c.message)}</span>
                    </div>
                `)
                .join('');
        }

        function renderDebugState() {
            const el = document.getElementById('twc-debug-state');
            if (!el) return;
            const yn = (b) => (b ? '<span class="twc-ok">yes</span>' : '<span class="twc-bad">no</span>');
            const present = (v) => (v ? `<span class="twc-ok">set (${v.length} chars)</span>` : '<span class="twc-bad">EMPTY</span>');
            el.innerHTML = `
                state: <b>${StateMachine.getState()}</b><br>
                apiKey: ${present(userConfig.apiKey)}<br>
                ownFactionId: ${userConfig.ownFactionId || '<span class="twc-bad">EMPTY</span>'}<br>
                enemyFactionId (pinned): ${userConfig.enemyFactionId || '<span style="opacity:.5">auto-detect</span>'}<br>
                allyWebhook: ${present(userConfig.discordWebhookAlly)}<br>
                enemyWebhook: ${present(userConfig.discordWebhookEnemy)}<br>
                traveling: ${yn(travelState.active)}${travelState.active ? ` (${travelState.phase}, ${travelState.destination})` : ''}<br>
                last error: ${data.lastError ? `<span class="twc-bad">${escapeHtml(data.lastError)}</span>` : '<span class="twc-ok">none</span>'}
            `;
        }

        function renderDebugFilters() {
            const el = document.getElementById('twc-debug-filters');
            if (!el) return;
            const levels = ['all', 'info', 'success', 'warn', 'error', 'critical'];
            el.innerHTML = levels
                .map((lvl) => `<button class="twc-debug-filter-btn ${((debugFilter || 'all') === lvl) ? 'active' : ''}" data-level="${lvl}">${lvl}</button>`)
                .join('');
            el.querySelectorAll('.twc-debug-filter-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    debugFilter = btn.dataset.level === 'all' ? null : btn.dataset.level;
                    renderDebugFilters();
                    renderDebugModal(debugFilter);
                });
            });
        }

        function renderDebugModal(filterSeverity) {
            renderDebugState();
            renderDebugTabs();

            if (debugTab === 'history') return renderHistoryTab();
            if (debugTab === 'health') return renderHealthTab();

            const body = document.getElementById('twc-debug-body');
            if (!body) return;
            const entries = filterSeverity
                ? Debug.entries.filter((e) => e.severity === filterSeverity)
                : Debug.entries;

            if (!entries.length) {
                body.innerHTML = `<div class="twc-empty">No log entries yet.</div>`;
                return;
            }

            body.innerHTML = entries
                .map((e) => `
                    <div class="twc-log-line twc-log-${e.severity}">
                        <span class="twc-log-time">${new Date(e.timestamp).toLocaleTimeString()}</span>
                        <span class="twc-log-sev">${SEVERITY[e.severity].label}</span>
                        <span class="twc-log-src">${escapeHtml(e.source)}</span>
                        <span class="twc-log-msg">${escapeHtml(e.message)}</span>
                    </div>
                `)
                .join('');
        }

        debugModal.querySelectorAll('.twc-debug-tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                debugTab = btn.dataset.tab;
                renderDebugModal(debugFilter);
            });
        });

        function openDebug(filterSeverity) {
            debugTab = 'log';
            debugFilter = filterSeverity || null;
            renderDebugFilters();
            renderDebugModal(debugFilter);
            debugModal.classList.add('open');
            backdrop.classList.add('open');
        }
        function closeDebug() {
            debugModal.classList.remove('open');
            backdrop.classList.remove('open');
        }
        document.getElementById('twc-debug-close').addEventListener('click', closeDebug);

        document.getElementById('twc-debug-poll').addEventListener('click', () => {
            Debug.log('info', 'Debug', 'Manual force-poll triggered.');
            poll();
        });

        document.getElementById('twc-debug-test').addEventListener('click', () => {
            Debug.log('info', 'Debug', 'Manual test alert triggered — bypassing all hospital/war checks.');
            ['ally', 'enemy'].forEach((side) => {
                Discord.send({
                    embeds: [{
                        title: `War Call test ping (${side})`,
                        description: `If you see this in Discord, your ${side} webhook is configured correctly.`,
                        color: side === 'enemy' ? 0xff5c5c : 0x39ff8a
                    }]
                }, side).then(() => {
                    Debug.log('success', 'Debug', `${side} test alert sent successfully.`);
                }).catch((err) => {
                    Debug.log('error', 'Debug', `${side} test alert failed: ${err.message}`);
                });
            });
        });

        document.getElementById('twc-debug-clear').addEventListener('click', () => {
            Debug.entries = [];
            renderDebugModal(debugFilter);
        });

        // Live-refresh the debug panel while it's open, so it doesn't go
        // stale mid-diagnosis (e.g. while chasing the travel-fetch logs).
        EventBus.on('debug:entry', () => {
            if (debugModal.classList.contains('open')) renderDebugModal(debugFilter);
        });

        function openSettings() {
            settingsModal.classList.add('open');
            backdrop.classList.add('open');
        }
        function closeSettings() {
            settingsModal.classList.remove('open');
            backdrop.classList.remove('open');
        }

        document.getElementById('twc-settings-btn').addEventListener('click', openSettings);
        document.getElementById('twc-settings-close').addEventListener('click', closeSettings);
        backdrop.addEventListener('click', () => {
            closeSettings();
            closeDebug();
            closePingConfig();
        });

        document.getElementById('twc-settings-save').addEventListener('click', () => {
            userConfig.apiKey = document.getElementById('twc-input-apikey').value.trim();
            userConfig.ownFactionId = document.getElementById('twc-input-ownfaction').value.trim();
            userConfig.enemyFactionId = document.getElementById('twc-input-enemyfaction').value.trim();
            userConfig.discordWebhookAlly = document.getElementById('twc-input-webhook-ally').value.trim();
            userConfig.discordWebhookEnemy = document.getElementById('twc-input-webhook-enemy').value.trim();
            delete userConfig.discordWebhook; // migrated to the ally/enemy split — no longer used anywhere
            ConfigStore.save(userConfig);
            Debug.log('info', 'Settings', 'Configuration saved.');
            closeSettings();
            StateMachine.setState(StateMachine.STATES.UNKNOWN, { forceRecover: true, reason: 'settings changed' });
            poll();
        });

        const EXPORT_FORMAT_VERSION = 1;

        document.getElementById('twc-export-config').addEventListener('click', () => {
            const payload = {
                exportFormatVersion: EXPORT_FORMAT_VERSION,
                exportedAt: new Date().toISOString(),
                scriptVersion: BuildInfo.version,
                userConfig,
                uiPrefs
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `torn-war-call-config-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            Debug.log('success', 'Settings', 'Configuration exported.');
        });

        document.getElementById('twc-import-config').addEventListener('click', () => {
            document.getElementById('twc-import-file').click();
        });

        document.getElementById('twc-import-file').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = () => {
                let parsed;
                try {
                    parsed = JSON.parse(reader.result);
                } catch (err) {
                    Debug.log('error', 'Settings', `Import failed: file is not valid JSON (${err.message}).`);
                    alert('Import failed: that file is not valid JSON.');
                    return;
                }

                // Validate shape before touching anything — reject gracefully
                // rather than half-applying a corrupted or foreign file.
                if (!parsed || typeof parsed !== 'object' || !parsed.userConfig || typeof parsed.userConfig !== 'object') {
                    Debug.log('error', 'Settings', 'Import failed: file is missing expected userConfig structure.');
                    alert('Import failed: this doesn\'t look like a Torn War Call export.');
                    return;
                }

                if (typeof parsed.exportFormatVersion !== 'number' || parsed.exportFormatVersion > EXPORT_FORMAT_VERSION) {
                    Debug.log('error', 'Settings', `Import failed: export format version ${parsed.exportFormatVersion} is newer than this script supports (${EXPORT_FORMAT_VERSION}).`);
                    alert('Import failed: this file was exported from a newer version of the script than you\'re running.');
                    return;
                }

                Object.assign(userConfig, parsed.userConfig);
                delete userConfig.discordWebhook; // in case an old export predates the ally/enemy split
                if (parsed.uiPrefs && typeof parsed.uiPrefs === 'object') {
                    Object.assign(uiPrefs, parsed.uiPrefs);
                    saveUiPrefs();
                }
                ConfigStore.save(userConfig);

                Debug.log('success', 'Settings', `Configuration imported from a v${parsed.scriptVersion || 'unknown'} export.`);
                closeSettings();
                StateMachine.setState(StateMachine.STATES.UNKNOWN, { forceRecover: true, reason: 'config imported' });
                poll();
            };
            reader.onerror = () => {
                Debug.log('error', 'Settings', 'Import failed: could not read the file.');
            };
            reader.readAsText(file);
            e.target.value = ''; // allow re-importing the same filename later
        });

        document.getElementById('twc-debug-btn').addEventListener('click', () => openDebug());

        document.getElementById('twc-collapse-btn').addEventListener('click', () => setCollapsed(true));
        document.getElementById('twc-hide-btn').addEventListener('click', () => setHidden(true));

        // Per-section (Enemy/Ally) collapse — independent of the whole-panel
        // collapse above. Persisted so it survives a page reload.
        function applySectionCollapse(section) {
            const listEl = document.getElementById(section === 'enemy' ? 'twc-enemy-list' : 'twc-ally-list');
            const toggleEl = panelEl.querySelector(`.twc-section-toggle[data-section="${section}"]`);
            if (!listEl || !toggleEl) return;
            const isCollapsed = !!uiPrefs.sectionsCollapsed[section];
            listEl.classList.toggle('twc-section-collapsed', isCollapsed);
            toggleEl.classList.toggle('twc-section-collapsed', isCollapsed);
        }

        panelEl.querySelectorAll('.twc-section-toggle').forEach((toggleEl) => {
            toggleEl.addEventListener('click', () => {
                const section = toggleEl.dataset.section;
                uiPrefs.sectionsCollapsed[section] = !uiPrefs.sectionsCollapsed[section];
                saveUiPrefs();
                applySectionCollapse(section);
            });
        });

        applySectionCollapse('enemy');
        applySectionCollapse('ally');

        document.getElementById('twc-status').addEventListener('click', () => {
            if (StateMachine.getState() === StateMachine.STATES.FAILURE) {
                openDebug('critical');
            }
        });

        makeDraggable();
        watchResize();
        applyVisibilityToDom();
    }

    function makeDraggable() {
        const header = document.getElementById('twc-header');
        let dragging = false, offX = 0, offY = 0;

        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('.twc-icon')) return;
            dragging = true;
            const rect = panelEl.getBoundingClientRect();
            offX = e.clientX - rect.left;
            offY = e.clientY - rect.top;
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const width = panelEl.offsetWidth;
            const rawLeft = e.clientX - offX;
            const rawTop = e.clientY - offY;
            const left = Math.min(Math.max(rawLeft, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN));
            const top = Math.min(Math.max(rawTop, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerHeight - 40 - VIEWPORT_MARGIN));
            panelEl.style.left = `${left}px`;
            panelEl.style.top = `${top}px`;
            panelEl.style.right = 'auto';
            uiPrefs.top = top;
            uiPrefs.right = window.innerWidth - (left + width);
        });
        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                clampPanelGeometry();
            }
        });
    }

    function watchResize() {
        if (typeof ResizeObserver === 'undefined') return;
        let debounceTimer = null;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            const { width, height } = entry.contentRect;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                uiPrefs.width = Math.round(width);
                uiPrefs.height = Math.round(height);
                clampPanelGeometry();
            }, 300);
        });
        observer.observe(panelEl);

        // The browser window itself can shrink after a size/position was
        // saved for a larger screen — re-clamp whenever that happens too.
        let resizeDebounce = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeDebounce);
            resizeDebounce = setTimeout(clampPanelGeometry, 150);
        });
    }

    function renderStatusHeader() {
        const el = els.status;
        if (!el) return;

        const current = StateMachine.getState();
        const display = STATUS_DISPLAY[current] || STATUS_DISPLAY.unknown;
        const meta = StateMachine.getMeta();

        let label = display.label;
        if (current === StateMachine.STATES.WAR_ENDED) {
            if (meta.outcome === 'won') label = 'War Ended — Victory!';
            else if (meta.outcome === 'lost') label = 'War Ended — Tough fight, get them next time.';
            else label = 'War Ended';
        }

        el.textContent = label;
        el.style.color = display.color;
        el.classList.toggle('clickable', current === StateMachine.STATES.FAILURE);
    }

    // Classifies a member into what the panel actually needs to show for
    // them right now — null means "nothing relevant, don't render this row".
    function classifyPlayer(member, now) {
        const state = String(member.state || '').toLowerCase();
        if (state === 'hospital' && member.until > now) return 'hospital';
        if (state === 'traveling') return 'traveling';
        if (state === 'abroad') return 'abroad';
        return null;
    }

    function renderPlayer(player, now) {
        if (player._kind === 'hospital') {
            const secondsLeft = Math.max(0, player.until - now);
            const warning = secondsLeft <= WARNING_SECONDS;
            return `
                <div class="twc-player ${warning ? 'twc-warning' : ''}">
                    <div class="twc-player-name">
                        <a href="${escapeHtml(getPlayerUrl(player.id))}" target="_blank" rel="noopener noreferrer">${escapeHtml(player.name)}</a>
                    </div>
                    <div class="twc-player-meta">Lv. ${escapeHtml(player.level || '?')} · ${escapeHtml(formatTime(secondsLeft))}</div>
                </div>
            `;
        }

        // traveling or abroad — no urgency pulse, just status + countdown
        // if one applies. Members mid-flight (traveling) have an arrival
        // time; members just sitting in a country (abroad) don't.
        const hasCountdown = player._kind === 'traveling' && player.until > now;
        const metaText = hasCountdown
            ? `${player.description || 'Traveling'} · ${formatTime(player.until - now)}`
            : (player.description || (player._kind === 'abroad' ? 'Abroad' : 'Traveling'));

        return `
            <div class="twc-player twc-player-travel">
                <div class="twc-player-name">
                    <a href="${escapeHtml(getPlayerUrl(player.id))}" target="_blank" rel="noopener noreferrer">${escapeHtml(player.name)}</a>
                </div>
                <div class="twc-player-meta">${escapeHtml(metaText)}</div>
            </div>
        `;
    }

    function renderPlayerList(element, players, now) {
        if (!element) return;
        if (!players.length) {
            element.innerHTML = `<div class="twc-empty">Nothing to show right now.</div>`;
            return;
        }
        element.innerHTML = players.map((p) => renderPlayer(p, now)).join('');
    }

    function renderTravel() {
        const el = els.travel;
        if (!el) return;

        if (!travelState.active) {
            el.style.display = 'none';
            return;
        }

        el.style.display = 'block';
        const now = Math.floor(Date.now() / 1000);
        const secondsLeft = Math.max(0, travelState.arrival - now);
        const dest = escapeHtml(travelState.destination);

        if (travelState.phase === 'returning') {
            // Primary emphasis: this is the number that matters for faction planning.
            el.innerHTML = `
                <div class="twc-travel-route">${dest} &rarr; Torn</div>
                <div class="twc-travel-eta">Back in Torn: ${formatTime(secondsLeft)}</div>
            `;
        } else {
            // Outbound: this is all the data Torn exposes until the return leg
            // actually starts (no total round-trip estimate exists yet), so it
            // renders de-emphasized rather than pretending to know the homecoming time.
            el.innerHTML = `
                <div class="twc-travel-route">Torn &rarr; ${dest}</div>
                <div class="twc-travel-eta twc-travel-secondary">Arriving in ${dest}: ${formatTime(secondsLeft)}</div>
            `;
        }
    }

    // Combines hospital + traveling + abroad into one sorted list per side.
    // Hospital entries always sort first (most actionable — this is what a
    // war-call panel exists for), then traveling/abroad entries by soonest
    // arrival, with stationary "abroad" entries (no countdown) last.
    function buildRelevantList(list, now) {
        return list
            .map((m) => ({ ...m, _kind: classifyPlayer(m, now) }))
            .filter((m) => m._kind)
            .map((m) => ({
                ...m,
                _sortValue: m._kind === 'hospital'
                    ? m.until - now
                    : (m._kind === 'traveling' && m.until > now ? 1000000 + (m.until - now) : Infinity)
            }))
            .sort((a, b) => a._sortValue - b._sortValue);
    }

    // Performance: the 1-second tick only needs to re-render when something
    // on screen is actually counting down. During Peace, or when nobody's
    // hospitalized/traveling, rebuilding the same static HTML every second
    // is pure wasted DOM work. This is checked before the tick calls render()
    // at all — see setInterval below.
    function anyActiveCountdown() {
        const now = Math.floor(Date.now() / 1000);
        const hasCountdown = (list) => list.some((m) => {
            const state = String(m.state || '').toLowerCase();
            return (state === 'hospital' || state === 'traveling') && m.until > now;
        });
        return travelState.active || hasCountdown(data.enemy) || hasCountdown(data.ally);
    }

    function render() {
        try {
            renderInner();
        } catch (err) {
            // A render failure must never take down the whole script or spam
            // an uncaught exception every second — log once and move on.
            Debug.log('error', 'Render', `Render failed: ${err.message}`);
        }
    }

    function renderInner() {
        const now = Math.floor(Date.now() / 1000);

        renderPlayerList(els.enemyList, buildRelevantList(data.enemy, now), now);
        renderPlayerList(els.allyList, buildRelevantList(data.ally, now), now);

        if (els.error) els.error.textContent = data.lastError || '';

        if (els.lastUpdate) {
            els.lastUpdate.textContent = data.lastUpdate ? `Last update: ${new Date(data.lastUpdate).toLocaleTimeString()}` : '';
        }

        if (els.version) {
            els.version.textContent = `v${BuildInfo.version} · build ${BuildInfo.build} · ${BuildInfo.releaseDate} · init ${BuildInfo.initTime.toLocaleTimeString()}`;
        }

        renderStatusHeader();
        renderTravel();
    }

    EventBus.on('state:change', render);
    EventBus.on('visibility:page-changed', ({ onFactionPage }) => {
        // IMPORTANT: only the panel's DOM visibility is gated to faction pages.
        // Polling (and therefore Discord alerts) must keep running regardless —
        // the entire point of a Discord alert is to notify you when you are
        // NOT looking at the panel. Do not tie the poller itself to page
        // visibility, or alerts silently stop the moment you navigate away.
        applyVisibilityToDom();
        Debug.log('info', 'Visibility', onFactionPage ? 'Entered faction page — panel shown.' : 'Left faction page — panel hidden, polling continues.');
    });

    // =========================================================================
    // MODULE: Poller
    // =========================================================================
    let polling = false;
    let pollTimeoutHandle = null;
    let backoffMs = 0;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;
    const MAX_BACKOFF_MS = 5 * 60 * 1000; // never wait longer than 5 min between attempts

    // Torn API error format is "CODE: message" — code 5 is specifically
    // "Too many requests". Detected here rather than assumed, so a change
    // in Torn's wording doesn't silently break backoff (falls back to
    // treating it as a normal error instead of misfiring backoff logic).
    function isRateLimitError(message) {
        return typeof message === 'string' && message.startsWith('5:');
    }

    async function poll() {
        if (polling) return;
        polling = true;
        let rateLimitHitThisCycle = false;

        try {
            const ownFactionId = Number(userConfig.ownFactionId || 0);

            if (!ownFactionId) {
                data.lastError = 'Set your Faction ID in Settings (⚙) before this can do anything.';
                data.lastUpdate = Date.now();
                render();
                return;
            }

            const now = Math.floor(Date.now() / 1000);

            // Isolated on purpose: a travel-endpoint hiccup must never break
            // war detection or hospital alerts, which are the core function.
            try {
                const travelResponse = await TravelTracker.fetch();
                updateTravelState(TravelTracker.derive(travelResponse));
            } catch (travelError) {
                if (isRateLimitError(travelError.message)) rateLimitHitThisCycle = true;
                Debug.log('warn', 'Travel', `Failed to fetch travel status: ${travelError.message}`);
            }

            const rankedWar = await WarDetection.getRankedWar(ownFactionId);
            const { phase, war, outcome } = WarDetection.derivePhase(rankedWar, now);

            // Error recovery: reaching this line means the core API call
            // succeeded. If we were previously in FAILURE, that's proof the
            // underlying problem resolved itself — recover automatically
            // instead of leaving the panel stuck showing "Script Failure"
            // forever until someone manually re-saves Settings.
            if (consecutiveFailures > 0) {
                Debug.log('success', 'Poller', `Recovered after ${consecutiveFailures} consecutive failure(s).`);
            }
            consecutiveFailures = 0;

            const stateMeta = { war, outcome };
            if (StateMachine.getState() === StateMachine.STATES.FAILURE) stateMeta.forceRecover = true;
            StateMachine.setState(phase, stateMeta);

            data.ally = await WarDetection.getOwnFactionMembers(ownFactionId);

            if (phase === StateMachine.STATES.ACTIVE_WAR) {
                const enemyFactionId = WarDetection.resolveEnemyFactionId(war);
                if (enemyFactionId) {
                    data.enemy = await WarDetection.getEnemyFactionMembers(enemyFactionId);
                } else {
                    data.enemy = [];
                    Debug.log('warn', 'WarDetection', 'Active war detected but enemy faction ID could not be resolved.');
                }
            } else {
                data.enemy = [];
            }

            // Ping evaluation checks the war state internally via
            // isPingSystemActive(), so pings correctly start as soon as a
            // war is scheduled (War Preparation), not only once it's live.
            evaluatePings(data.enemy, 'enemy');
            evaluatePings(data.ally, 'ally');
            pruneFiredPings(data.ally, data.enemy);

            data.lastError = '';
            data.lastUpdate = Date.now();
            render();
        } catch (error) {
            data.lastError = error?.message || String(error);
            data.lastUpdate = Date.now();
            if (isRateLimitError(data.lastError)) rateLimitHitThisCycle = true;

            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                // Genuinely persistent — not a one-off network blip. This is
                // the "recovery is impossible without intervention" case the
                // spec calls out; everything below this threshold is treated
                // as recoverable and doesn't escalate the state at all.
                Debug.log('critical', 'Poller', `${consecutiveFailures} consecutive poll failures — last error: ${data.lastError}`);
            } else {
                Debug.log('error', 'Poller', `${data.lastError} (failure ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} before escalating)`);
            }
            render();
        } finally {
            polling = false;

            if (rateLimitHitThisCycle) {
                backoffMs = backoffMs === 0 ? POLL_INTERVAL_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
                Debug.log('warn', 'Poller', `Rate limited by Torn — backing off, next attempt in ${formatTime(Math.round((POLL_INTERVAL_MS + backoffMs) / 1000))}.`);
            } else if (backoffMs > 0) {
                Debug.log('success', 'Poller', 'Rate limit cleared — back to normal poll interval.');
                backoffMs = 0;
            }

            scheduleNextPoll();
        }
    }

    function scheduleNextPoll() {
        if (pollTimeoutHandle) clearTimeout(pollTimeoutHandle);
        pollTimeoutHandle = setTimeout(poll, POLL_INTERVAL_MS + backoffMs);
    }

    function startPolling() {
        if (pollTimeoutHandle) return;
        poll();
    }

    function stopPolling() {
        if (pollTimeoutHandle) {
            clearTimeout(pollTimeoutHandle);
            pollTimeoutHandle = null;
        }
    }

    // =========================================================================
    // INIT
    // =========================================================================
    let initialized = false;

    function init() {
        if (initialized) return;
        initialized = true;

        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('Show/Hide War Call Panel', () => setHidden(!uiPrefs.hidden));
        }

        createPanel();
        render();

        // Polling always runs once the script is loaded, independent of
        // which Torn page you're on — see the visibility:page-changed
        // handler above for why this can't be gated to faction pages.
        startPolling();

        // Fast local tick so hospital/travel countdowns move every second
        // instead of only jumping once per 15s poll cycle. Gated on
        // anyActiveCountdown() so idle periods (Peace, nobody hospitalized)
        // don't rebuild static HTML every second for nothing — a real
        // performance difference over a long session, not a cosmetic one.
        setInterval(() => {
            if (anyActiveCountdown()) render();
        }, 1000);

        History.add({ type: 'script_initialized' });
        Debug.log('success', 'Init', `Torn War Call ${BuildInfo.version} initialized (${BuildInfo.notes})`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();