// ==UserScript==
// @name         Torn War Call
// @namespace    https://github.com/Yanu-desu/Torn-War-Call
// @version      3.3.1
// @description  Read-only Torn faction war hospital intel panel with Discord alerts, centralized state machine.
// @author       Yanu [3028844]
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
     * Torn War Call — v3.2.0 "Phase 2"
     *
     * Phase 1 recap: modular architecture, centralized state machine,
     * war-phase detection (v2 API), status header, cyberpunk UI.
     *
     * Phase 2 adds:
     *   - Resizable panel (native corner resize handle, persisted size).
     *   - Draggable panel with persisted position.
     *   - Collapsible side tab (click to restore).
     *   - Full hide via BOTH a Tampermonkey menu command AND a small
     *     persistent reopen tab, per explicit instruction to do both.
     *   - Faction-page-only visibility. Torn does full page loads per
     *     navigation (not a persistent SPA), so this re-evaluates cleanly
     *     each load; a light interval catches any in-page AJAX tab changes
     *     within the faction section without needing a MutationObserver.
     *   - Polling suspends entirely off faction pages (real perf win, not
     *     just a DOM hide) per the performance requirements.
     *
     * Compromise made without asking: "resizable by dragging edges or
     * corners" is implemented via the browser's native CSS resize handle,
     * which is corner-only in every major browser. A custom 4-edge drag
     * system is real added complexity for marginal benefit — flag if you
     * actually want all four edges built out.
     *
     * Still NOT in scope: travel notifications, ping config slots,
     * debug severity filter/search UI, notification history panel UI,
     * health monitor, import/export, error-recovery framework.
     */

    // =========================================================================
    // MODULE: BuildInfo
    // =========================================================================
    const BuildInfo = {
        version: '3.3.1',
        build: 15,
        releaseDate: '2026-08-08',
        initTime: new Date(),
        phase: 'Phase 3 fix — real debug panel, traveling/abroad section, travel diagnostics'
    };

    // =========================================================================
    // MODULE: Config (storage keys, load/save)
    // =========================================================================
    const CONFIG_KEYS = {
        USER_CONFIG: 'twc-config',
        HISTORY: 'twc-history',
        UI_PREFS: 'twc-ui-prefs'
    };

    const POLL_INTERVAL_MS = 15000;
    const WARNING_SECONDS = 60;
    const WAR_ENDED_DISPLAY_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
    const PAGE_CHECK_INTERVAL_MS = 4000;

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
    const uiPrefs = Object.assign(
        { width: 420, height: null, top: 120, right: 20, collapsed: false, hidden: false },
        UIPrefsStore.load()
    );

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
        send(payload) {
            const webhook = userConfig.discordWebhook;
            if (!webhook) {
                Debug.log('warn', 'Discord', 'No webhook configured — alert skipped.');
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
    // Detects Torn travel status and derives outbound/returning phase.
    //
    // API note: this uses the v1 `/user/?selections=travel,basic` endpoint,
    // not v2 — travel is a legacy selection that's been stable for years,
    // unlike the faction/wars endpoint that forced the v2 switch earlier.
    // If this throws error 23 ("only available in API v2") the same way
    // the faction call did, that means Torn deprecated it since — report
    // back and this gets the same v2 treatment.
    //
    // Per explicit instruction: no wall-clock ETAs are shown, only a
    // direction label (Torn -> destination, or destination -> Torn) and a
    // relative countdown. formatTime() already returns a duration, never
    // a clock time, so that constraint falls out naturally.
    // =========================================================================
    const TravelTracker = {
        async fetch() {
            return TornAPI.request('/user/', { selections: 'travel,basic' });
        },

        // Returns null when not traveling, otherwise { phase, destination, arrival }.
        // phase is 'outbound' (heading to destination) or 'returning' (heading home).
        derive(response) {
            // Logged every poll at 'info' level so the debug panel shows exactly
            // what Torn's API sent — this is how we confirm/fix field names
            // instead of guessing blind, same approach that found the v1/v2
            // faction mismatch earlier.
            Debug.log('info', 'Travel', `raw response: ${JSON.stringify(response)}`);

            const travel = response?.travel || {};
            const status = response?.status || response?.basic?.status || {};

            const stateRaw = String(status.state || '').toLowerCase();
            const isTraveling = stateRaw === 'traveling';
            const destination = travel.destination || '';

            if (!isTraveling || !destination) return null;

            const description = String(status.description || '').toLowerCase();
            const phase = description.includes('return') ? 'returning' : 'outbound';
            const arrival = Number(travel.timestamp || travel.time_left_end || status.until || 0);

            return { phase, destination, arrival };
        }
    };

    let travelState = { active: false, phase: null, destination: '', arrival: 0 };

    function updateTravelState(info) {
        if (!info) {
            if (travelState.active) {
                const arrivedHome = travelState.phase === 'returning';
                Debug.log('success', 'Travel', arrivedHome ? 'Arrived back in Torn.' : `Arrived in ${travelState.destination}.`);
                History.add({ type: arrivedHome ? 'arrived_home' : 'arrived_abroad', destination: travelState.destination });
            }
            travelState = { active: false, phase: null, destination: '', arrival: 0 };
            return;
        }

        const changed = travelState.phase !== info.phase || travelState.destination !== info.destination;
        if (changed) {
            Debug.log(
                'info', 'Travel',
                info.phase === 'outbound'
                    ? `Travel started: Torn -> ${info.destination}`
                    : `Return travel started: ${info.destination} -> Torn`
            );
            History.add({
                type: info.phase === 'outbound' ? 'travel_started' : 'return_started',
                destination: info.destination
            });
        }

        travelState = { active: true, phase: info.phase, destination: info.destination, arrival: info.arrival };
    }

    // =========================================================================
    // MODULE: HospitalAlerts
    // =========================================================================
    const alertedHospitals = new Set();

    function hospitalKey(player) { return `${player.id}:${player.until}`; }

    function shouldAlert(player, now) {
        if (!player.until) return false;
        const secondsLeft = player.until - now;
        if (secondsLeft <= 0 || secondsLeft > WARNING_SECONDS) return false;
        const key = hospitalKey(player);
        if (alertedHospitals.has(key)) return false;
        alertedHospitals.add(key);
        return true;
    }

    function formatTime(seconds) {
        seconds = Math.max(0, Math.floor(seconds));
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return minutes > 0 ? `${minutes}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
    }

    function getPlayerUrl(id) {
        return `https://www.torn.com/profiles.php?XID=${encodeURIComponent(id)}`;
    }

    async function fireHospitalAlert(player, kind) {
        const secondsLeft = Math.max(0, player.until - Math.floor(Date.now() / 1000));
        History.add({ type: kind, id: player.id, name: player.name, until: player.until });

        try {
            await Discord.send({
                embeds: [{
                    title: kind === 'enemy' ? 'Enemy hospital release' : 'Ally hospital release',
                    description: `**${player.name}** is leaving hospital in **${formatTime(secondsLeft)}**.`,
                    fields: [
                        { name: 'Player', value: `[${player.name}](${getPlayerUrl(player.id)})`, inline: true },
                        { name: 'Level', value: String(player.level || 'Unknown'), inline: true }
                    ],
                    timestamp: new Date().toISOString()
                }]
            });
            Debug.log('success', 'HospitalAlerts', `Sent ${kind} alert for ${player.name}`);
        } catch (error) {
            Debug.log('error', 'HospitalAlerts', `Failed to send ${kind} alert for ${player.name}: ${error.message}`);
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
        eye: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
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

    function applyPanelGeometry() {
        if (!panelEl) return;
        panelEl.style.top = `${uiPrefs.top}px`;
        panelEl.style.right = `${uiPrefs.right}px`;
        panelEl.style.width = `${uiPrefs.width}px`;
        if (uiPrefs.height) panelEl.style.height = `${uiPrefs.height}px`;
    }

    function applyVisibilityToDom() {
        const onFactionPage = Visibility.isOnFactionPage();

        if (!onFactionPage) {
            if (panelEl) panelEl.style.display = 'none';
            if (collapsedTabEl) collapsedTabEl.style.display = 'none';
            if (reopenTabEl) reopenTabEl.style.display = 'none';
            return;
        }

        if (uiPrefs.hidden) {
            if (panelEl) panelEl.style.display = 'none';
            if (collapsedTabEl) collapsedTabEl.style.display = 'none';
            if (reopenTabEl) reopenTabEl.style.display = 'flex';
            return;
        }

        if (reopenTabEl) reopenTabEl.style.display = 'none';

        if (uiPrefs.collapsed) {
            if (panelEl) panelEl.style.display = 'none';
            if (collapsedTabEl) collapsedTabEl.style.display = 'flex';
        } else {
            if (panelEl) panelEl.style.display = 'flex';
            if (collapsedTabEl) collapsedTabEl.style.display = 'none';
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
            .twc-player { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 8px;
                margin-bottom: 4px; border-radius: 3px; background: rgba(0,234,255,.03); border: 1px solid rgba(0,234,255,.15); }
            .twc-player.twc-warning { border-color: #ff2ec4; background: rgba(255,46,196,.12);
                box-shadow: 0 0 8px rgba(255,46,196,.4); animation: twc-pulse 1s infinite; }
            @keyframes twc-pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
            .twc-player-name { min-width: 0; flex: 1; }
            .twc-player-name a { color: #baf9ff; text-decoration: none; }
            .twc-player-name a:hover { text-decoration: underline; color: #00eaff; }
            .twc-player-meta { color: #6c8a99; font-size: 11px; text-align: right; }
            .twc-side-tag { display: inline-block; font-size: 9px; letter-spacing: .5px; text-transform: uppercase;
                padding: 1px 5px; border-radius: 2px; margin-right: 5px; font-weight: bold; }
            .twc-side-ally { background: rgba(57,255,138,.15); color: #39ff8a; }
            .twc-side-enemy { background: rgba(255,92,92,.15); color: #ff5c5c; }
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

            #twc-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 999998; display: none; }
            #twc-backdrop.open { display: block; }
            #twc-settings-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                width: 320px; z-index: 999999; color: #baf9ff;
                background: linear-gradient(180deg, #0b0e14 0%, #0a0c10 100%);
                border: 1px solid #ff2ec4; border-radius: 6px;
                box-shadow: 0 0 14px rgba(255,46,196,.4), 0 0 40px rgba(0,234,255,.1);
                display: none; font-family: 'Consolas','Courier New',monospace; font-size: 13px; }
            #twc-settings-modal.open { display: block; }
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

            #twc-debug-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                width: 460px; max-height: 70vh; display: flex; flex-direction: column;
                z-index: 999999; color: #baf9ff;
                background: linear-gradient(180deg, #0b0e14 0%, #0a0c10 100%);
                border: 1px solid #39ff8a; border-radius: 6px;
                box-shadow: 0 0 14px rgba(57,255,138,.4), 0 0 40px rgba(0,234,255,.1);
                display: none; font-family: 'Consolas','Courier New',monospace; font-size: 11px; }
            #twc-debug-modal.open { display: flex; }
            #twc-debug-header { display: flex; justify-content: space-between; align-items: center;
                padding: 10px 12px; border-bottom: 1px solid rgba(57,255,138,.3); background: rgba(57,255,138,.05);
                font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: #39ff8a;
                text-shadow: 0 0 6px rgba(57,255,138,.7); font-size: 12px; flex: 0 0 auto; }
            #twc-debug-close { cursor: pointer; opacity: .7; color: #39ff8a; }
            #twc-debug-close:hover { opacity: 1; text-shadow: 0 0 6px #39ff8a; }
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
                    <span class="twc-icon" id="twc-debug-btn" title="Debug">${Icons.wrench}</span>
                    <span class="twc-icon" id="twc-collapse-btn" title="Collapse">${Icons.collapse}</span>
                    <span class="twc-icon" id="twc-hide-btn" title="Hide">${Icons.eyeOff}</span>
                </div>
            </div>
            <div id="twc-status"></div>
            <div id="twc-travel" style="display:none;"></div>
            <div id="twc-body-scroll">
                <div class="twc-section">
                    <div class="twc-section-title">Enemy</div>
                    <div id="twc-enemy-list"><div class="twc-empty">Loading...</div></div>
                </div>
                <div class="twc-section">
                    <div class="twc-section-title">Ally</div>
                    <div id="twc-ally-list"><div class="twc-empty">Loading...</div></div>
                </div>
                <div class="twc-section">
                    <div class="twc-section-title">Traveling / Abroad</div>
                    <div id="twc-traveling-list"><div class="twc-empty">Loading...</div></div>
                </div>
            </div>
            <div id="twc-footer">
                <div id="twc-last-update"></div>
                <div id="twc-error"></div>
                <div id="twc-version"></div>
            </div>
        `;
        document.body.appendChild(panelEl);
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
                <div class="twc-field-label">Discord Webhook URL</div>
                <input id="twc-input-webhook" type="password" value="${escapeHtml(userConfig.discordWebhook || '')}">
                <button id="twc-settings-save">Save</button>
            </div>
        `;
        document.body.appendChild(settingsModal);

        const debugModal = document.createElement('div');
        debugModal.id = 'twc-debug-modal';
        debugModal.innerHTML = `
            <div id="twc-debug-header">
                <span>Debug Log</span>
                <span id="twc-debug-close">✕</span>
            </div>
            <div id="twc-debug-body"></div>
        `;
        document.body.appendChild(debugModal);

        function renderDebugModal(filterSeverity) {
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

        function openDebug(filterSeverity) {
            renderDebugModal(filterSeverity);
            debugModal.classList.add('open');
            backdrop.classList.add('open');
        }
        function closeDebug() {
            debugModal.classList.remove('open');
            backdrop.classList.remove('open');
        }
        document.getElementById('twc-debug-close').addEventListener('click', closeDebug);
        // Live-refresh the debug panel while it's open, so it doesn't go
        // stale mid-diagnosis (e.g. while chasing the travel-fetch logs).
        EventBus.on('debug:entry', () => {
            if (debugModal.classList.contains('open')) renderDebugModal();
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
        });

        document.getElementById('twc-settings-save').addEventListener('click', () => {
            userConfig.apiKey = document.getElementById('twc-input-apikey').value.trim();
            userConfig.ownFactionId = document.getElementById('twc-input-ownfaction').value.trim();
            userConfig.enemyFactionId = document.getElementById('twc-input-enemyfaction').value.trim();
            userConfig.discordWebhook = document.getElementById('twc-input-webhook').value.trim();
            ConfigStore.save(userConfig);
            Debug.log('info', 'Settings', 'Configuration saved.');
            closeSettings();
            StateMachine.setState(StateMachine.STATES.UNKNOWN, { forceRecover: true, reason: 'settings changed' });
            poll();
        });

        document.getElementById('twc-debug-btn').addEventListener('click', () => openDebug());

        document.getElementById('twc-collapse-btn').addEventListener('click', () => setCollapsed(true));
        document.getElementById('twc-hide-btn').addEventListener('click', () => setHidden(true));

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
            const left = e.clientX - offX;
            const top = e.clientY - offY;
            panelEl.style.left = `${left}px`;
            panelEl.style.top = `${top}px`;
            panelEl.style.right = 'auto';
            uiPrefs.top = top;
            uiPrefs.right = window.innerWidth - (left + panelEl.offsetWidth);
        });
        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                saveUiPrefs();
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
                saveUiPrefs();
            }, 300);
        });
        observer.observe(panelEl);
    }

    function renderStatusHeader() {
        const el = document.getElementById('twc-status');
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

    function renderPlayer(player, now) {
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

    function renderPlayerList(elementId, players, now) {
        const element = document.getElementById(elementId);
        if (!element) return;
        if (!players.length) {
            element.innerHTML = `<div class="twc-empty">No one currently in hospital.</div>`;
            return;
        }
        element.innerHTML = players.map((p) => renderPlayer(p, now)).join('');
    }

    function renderTravel() {
        const el = document.getElementById('twc-travel');
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

    function renderTravelingMembers() {
        const el = document.getElementById('twc-traveling-list');
        if (!el) return;

        const isAbroadOrTraveling = (m) => {
            const s = m.state.toLowerCase();
            return s === 'traveling' || s === 'abroad';
        };

        const allyAbroad = data.ally.filter(isAbroadOrTraveling).map((m) => ({ ...m, side: 'Ally' }));
        const enemyAbroad = data.enemy.filter(isAbroadOrTraveling).map((m) => ({ ...m, side: 'Enemy' }));
        const combined = [...allyAbroad, ...enemyAbroad];

        if (!combined.length) {
            el.innerHTML = `<div class="twc-empty">No one currently traveling or abroad.</div>`;
            return;
        }

        el.innerHTML = combined
            .map((m) => `
                <div class="twc-player">
                    <div class="twc-player-name">
                        <span class="twc-side-tag twc-side-${m.side.toLowerCase()}">${m.side}</span>
                        <a href="${escapeHtml(getPlayerUrl(m.id))}" target="_blank" rel="noopener noreferrer">${escapeHtml(m.name)}</a>
                    </div>
                    <div class="twc-player-meta">${escapeHtml(m.description || m.state)}</div>
                </div>
            `)
            .join('');
    }

    function render() {
        const now = Math.floor(Date.now() / 1000);
        const filterByStatus = (list) =>
            list
                .filter((m) => String(m.state || '').toLowerCase() === 'hospital' && m.until > now)
                .map((m) => ({ ...m, secondsLeft: m.until - now }))
                .sort((a, b) => a.secondsLeft - b.secondsLeft);

        renderPlayerList('twc-enemy-list', filterByStatus(data.enemy), now);
        renderPlayerList('twc-ally-list', filterByStatus(data.ally), now);
        renderTravelingMembers();

        const errorEl = document.getElementById('twc-error');
        if (errorEl) errorEl.textContent = data.lastError || '';

        const updateEl = document.getElementById('twc-last-update');
        if (updateEl) {
            updateEl.textContent = data.lastUpdate ? `Last update: ${new Date(data.lastUpdate).toLocaleTimeString()}` : '';
        }

        const versionEl = document.getElementById('twc-version');
        if (versionEl) {
            versionEl.textContent = `v${BuildInfo.version} · build ${BuildInfo.build} · ${BuildInfo.releaseDate} · init ${BuildInfo.initTime.toLocaleTimeString()}`;
        }

        renderStatusHeader();
        renderTravel();
    }

    EventBus.on('state:change', render);
    EventBus.on('visibility:page-changed', ({ onFactionPage }) => {
        // IMPORTANT: only the panel's DOM visibility is gated to faction pages.
        // Polling (and therefore Discord alerts) must keep running regardless —
        // the entire point of a Discord alert is to notify you when you are
        // NOT looking at the panel. Tying the poller itself to page visibility
        // was a Phase 2 regression: it silently killed all alerts the moment
        // you navigated off the faction page.
        applyVisibilityToDom();
        Debug.log('info', 'Visibility', onFactionPage ? 'Entered faction page — panel shown.' : 'Left faction page — panel hidden, polling continues.');
    });

    // =========================================================================
    // MODULE: Poller
    // =========================================================================
    let polling = false;
    let pollTimer = null;

    async function poll() {
        if (polling) return;
        polling = true;

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
                Debug.log('warn', 'Travel', `Failed to fetch travel status: ${travelError.message}`);
            }

            const rankedWar = await WarDetection.getRankedWar(ownFactionId);
            const { phase, war, outcome } = WarDetection.derivePhase(rankedWar, now);

            StateMachine.setState(phase, { war, outcome });

            data.ally = await WarDetection.getOwnFactionMembers(ownFactionId);

            if (phase === StateMachine.STATES.ACTIVE_WAR) {
                const enemyFactionId = WarDetection.resolveEnemyFactionId(war);
                if (enemyFactionId) {
                    data.enemy = await WarDetection.getEnemyFactionMembers(enemyFactionId);
                    for (const player of data.enemy) {
                        if (shouldAlert(player, now)) fireHospitalAlert(player, 'enemy');
                    }
                } else {
                    data.enemy = [];
                    Debug.log('warn', 'WarDetection', 'Active war detected but enemy faction ID could not be resolved.');
                }
                for (const player of data.ally) {
                    if (shouldAlert(player, now)) fireHospitalAlert(player, 'ally');
                }
            } else {
                data.enemy = [];
            }

            data.lastError = '';
            data.lastUpdate = Date.now();
            render();
        } catch (error) {
            data.lastError = error?.message || String(error);
            data.lastUpdate = Date.now();
            Debug.log('error', 'Poller', data.lastError);
            render();
        } finally {
            polling = false;
        }
    }

    function startPolling() {
        if (pollTimer) return;
        poll();
        pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
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

        // Fast local tick so hospital countdowns move every second instead
        // of only jumping once per 15s poll cycle. Cheap — it's a DOM text
        // update, not a network call.
        setInterval(render, 1000);

        History.add({ type: 'script_initialized' });
        Debug.log('success', 'Init', `Torn War Call ${BuildInfo.version} initialized (${BuildInfo.phase})`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();