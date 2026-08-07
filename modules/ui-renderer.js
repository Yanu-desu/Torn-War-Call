// Torn War Call — UI Renderer module
// Handles all presentation and DOM manipulation. Pure UI layer with no business logic.
// Listens to State and other modules, renders when data changes.

window.TWC = window.TWC || {};

window.TWC.UIRenderer = (function () {
  'use strict';

  const STATE = window.TWC.State;
  const TRAVEL_DISPLAY = window.TWC.TravelDisplay;
  const CONFIG = window.TWC.Config;
  const DEBUG = window.TWC.Debug;

  let panelElement = null;
  let isInitialized = false;

  // Status styling config
  const STATUS_CONFIG = {
    [STATE.STATES.UNKNOWN]: {
      text: 'Syncing...',
      color: '#95a5a6',
      icon: '🔄',
    },
    [STATE.STATES.PEACE]: {
      text: 'At Peace',
      color: '#27ae60',
      icon: '☮',
    },
    [STATE.STATES.WAR_PREP]: {
      text: 'War Scheduled',
      color: '#f39c12',
      icon: '⚙',
    },
    [STATE.STATES.ACTIVE_WAR]: {
      text: 'War Active',
      color: '#e74c3c',
      icon: '⚔',
    },
    [STATE.STATES.WAR_ENDED]: {
      text: 'War Ended',
      color: '#3498db',
      icon: '✓',
    },
    [STATE.STATES.FAILURE]: {
      text: 'Script Failure',
      color: '#c0392b',
      icon: '✕',
    },
  };

  function createStyles() {
    const style = document.createElement('style');
    style.id = 'twc-styles';
    style.textContent = `
      #twc-panel {
        position: fixed;
        top: 100px;
        right: 20px;
        width: ${CONFIG.get('panelWidth')}px;
        max-width: 90vw;
        z-index: 99999;
        background: #1b1e21;
        border: 1px solid #333;
        border-radius: 8px;
        color: #e6e6e6;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        display: flex;
        flex-direction: column;
        max-height: 90vh;
        overflow: hidden;
      }

      #twc-panel.hidden {
        display: none;
      }

      #twc-header {
        background: #262a2e;
        padding: 12px 14px;
        border-bottom: 1px solid #333;
        border-radius: 8px 8px 0 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
        user-select: none;
      }

      #twc-header h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #twc-status {
        background: #1e2327;
        padding: 8px 12px;
        border-bottom: 1px solid #333;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        font-weight: 500;
      }

      #twc-status-icon {
        min-width: 16px;
        text-align: center;
      }

      #twc-status-text {
        flex: 1;
      }

      #twc-body {
        flex: 1;
        overflow-y: auto;
        padding: 10px;
      }

      #twc-body.hidden { display: none; }

      .twc-section {
        margin-bottom: 12px;
      }

      .twc-section-title {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        color: #95a5a6;
        margin-bottom: 6px;
        opacity: 0.8;
      }

      .twc-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 8px;
        border-radius: 4px;
        margin-bottom: 3px;
        background: rgba(52, 73, 94, 0.3);
        font-size: 11px;
      }

      .twc-row.warn {
        background: rgba(231, 76, 60, 0.35);
        animation: twc-pulse 1.2s infinite;
      }

      .twc-row.ally-warn {
        background: rgba(46, 204, 113, 0.35);
        animation: twc-pulse 1.2s infinite;
      }

      @keyframes twc-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }

      .twc-empty {
        color: #7f8c8d;
        font-style: italic;
        padding: 6px 8px;
        font-size: 11px;
      }

      #twc-travel {
        background: rgba(52, 152, 219, 0.25);
        border-left: 3px solid #3498db;
        padding: 8px 10px;
        border-radius: 4px;
        margin-bottom: 10px;
      }

      #twc-travel.returning {
        background: rgba(230, 126, 34, 0.25);
        border-left-color: #e67e22;
      }

      #twc-travel-primary {
        font-weight: 600;
        margin-bottom: 2px;
      }

      #twc-travel-secondary {
        font-size: 10px;
        opacity: 0.8;
      }

      #twc-footer {
        background: #262a2e;
        padding: 8px 12px;
        border-top: 1px solid #333;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 10px;
        gap: 8px;
      }

      #twc-footer-controls {
        display: flex;
        gap: 6px;
      }

      #twc-footer-controls button {
        background: #34495e;
        color: #ecf0f1;
        border: none;
        padding: 4px 8px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 10px;
        transition: background 0.2s;
      }

      #twc-footer-controls button:hover {
        background: #2c3e50;
      }

      #twc-toggle-btn, #twc-hide-btn {
        min-width: 20px;
      }

      #twc-version {
        font-size: 9px;
        opacity: 0.6;
      }
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'twc-panel';
    if (CONFIG.get('panelHidden')) panel.classList.add('hidden');

    panel.innerHTML = `
      <div id="twc-header">
        <h2>
          <span id="twc-icon">📊</span>
          Torn War Call
        </h2>
        <div id="twc-header-actions">
          <button id="twc-toggle-btn" title="Toggle panel">▾</button>
        </div>
      </div>

      <div id="twc-status">
        <span id="twc-status-icon">🔄</span>
        <span id="twc-status-text">Syncing...</span>
      </div>

      <div id="twc-body">
        <div id="twc-travel" class="hidden"></div>
        <div id="twc-enemy-section" class="twc-section">
          <div class="twc-section-title">Enemy — Coming Out</div>
          <div id="twc-enemy-list"></div>
        </div>
        <div id="twc-ally-section" class="twc-section">
          <div class="twc-section-title">Ally — Almost Out</div>
          <div id="twc-ally-list"></div>
        </div>
      </div>

      <div id="twc-footer">
        <span id="twc-version">v${CONFIG.VERSION}</span>
        <div id="twc-footer-controls">
          <button id="twc-debug-btn" title="Debug">🔧</button>
          <button id="twc-settings-btn" title="Settings">⚙</button>
          <button id="twc-hide-btn" title="Hide UI">✕</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    panelElement = panel;

    // Event handlers
    document.getElementById('twc-toggle-btn').addEventListener('click', togglePanel);
    document.getElementById('twc-hide-btn').addEventListener('click', hidePanel);
    document.getElementById('twc-debug-btn').addEventListener('click', openDebug);
    document.getElementById('twc-settings-btn').addEventListener('click', openSettings);

    makeDraggable(panel, document.getElementById('twc-header'));
  }

  function makeDraggable(element, handle) {
    let dragging = false, offX = 0, offY = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      offX = e.clientX - element.offsetLeft;
      offY = e.clientY - element.offsetTop;
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      element.style.left = `${e.clientX - offX}px`;
      element.style.top = `${e.clientY - offY}px`;
      element.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => (dragging = false));
  }

  function togglePanel() {
    const body = document.getElementById('twc-body');
    const btn = document.getElementById('twc-toggle-btn');
    const isCollapsed = CONFIG.get('panelCollapsed');
    CONFIG.save('panelCollapsed', !isCollapsed);
    body.classList.toggle('hidden');
    btn.textContent = isCollapsed ? '▾' : '▸';
  }

  function hidePanel() {
    CONFIG.save('panelHidden', true);
    if (panelElement) panelElement.classList.add('hidden');
  }

  function showPanel() {
    CONFIG.save('panelHidden', false);
    if (panelElement) panelElement.classList.remove('hidden');
  }

  function openDebug() {
    // TODO: Implement debug panel
    if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'UI', 'Debug panel requested');
  }

  function openSettings() {
    // TODO: Implement settings panel
    if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'UI', 'Settings panel requested');
  }

  function updateStatus(state, context) {
    const config = STATUS_CONFIG[state] || STATUS_CONFIG[STATE.STATES.UNKNOWN];
    const icon = document.getElementById('twc-status-icon');
    const text = document.getElementById('twc-status-text');
    const statusEl = document.getElementById('twc-status');

    if (icon) icon.textContent = config.icon;
    if (text) text.textContent = config.text;
    if (statusEl) statusEl.style.borderLeft = `3px solid ${config.color}`;
  }

  function updateTravelDisplay() {
    const travelDisplay = TRAVEL_DISPLAY.getDisplay();
    const travelEl = document.getElementById('twc-travel');

    if (!travelDisplay.active) {
      travelEl.classList.add('hidden');
      return;
    }

    travelEl.classList.remove('hidden');
    if (travelDisplay.phase === 'returning') {
      travelEl.classList.add('returning');
    } else {
      travelEl.classList.remove('returning');
    }

    const primary = document.getElementById('twc-travel-primary');
    const secondary = document.getElementById('twc-travel-secondary');

    if (primary) primary.textContent = travelDisplay.primaryMessage;
    if (secondary) secondary.textContent = travelDisplay.secondaryMessage || '';
  }

  function formatTime(seconds) {
    if (seconds <= 0) return 'now';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function updateHospitalList(side, members) {
    const now = Math.floor(Date.now() / 1000);
    const warnWindow = CONFIG.get('warnWindowSeconds') || 60;
    const elementId = side === 'ally' ? 'twc-ally-list' : 'twc-enemy-list';
    const container = document.getElementById(elementId);

    if (!container) return;

    const hospitalized = members
      .filter((m) => m.state === 'Hospital' && m.until > now)
      .map((m) => ({ ...m, secondsLeft: m.until - now }))
      .sort((a, b) => a.secondsLeft - b.secondsLeft);

    if (hospitalized.length === 0) {
      container.innerHTML = '<div class="twc-empty">Nobody hospitalized</div>';
      return;
    }

    container.innerHTML = hospitalized
      .map((m) => {
        const isWarning = m.secondsLeft <= warnWindow;
        const warnClass = side === 'ally' ? 'ally-warn' : 'warn';
        return `
          <div class="twc-row ${isWarning ? warnClass : ''}">
            <span>${m.name} [${m.level}]</span>
            <span>${formatTime(m.secondsLeft)}</span>
          </div>
        `;
      })
      .join('');
  }

  function render() {
    if (!panelElement) return;

    const { state, context } = STATE.get();
    updateStatus(state, context);
    updateTravelDisplay();

    // Update hospital lists
    if (window.TWC.HospitalTracker) {
      updateHospitalList('ally', window.TWC.HospitalTracker.getMembers('ally'));
      updateHospitalList('enemy', window.TWC.HospitalTracker.getMembers('enemy'));
    }
  }

  function initialize() {
    if (isInitialized) return;
    createStyles();
    createPanel();
    isInitialized = true;

    // Listen to state changes
    if (STATE) STATE.subscribe(render);

    // Update travel display every second
    if (TRAVEL_DISPLAY) {
      setInterval(() => {
        if (!CONFIG.get('panelHidden')) {
          updateTravelDisplay();
        }
      }, 1000);
    }

    // Update hospital lists periodically (UI tick)
    setInterval(() => {
      if (!CONFIG.get('panelHidden')) {
        render();
      }
    }, 1000);

    if (DEBUG) DEBUG.log(DEBUG.SEVERITY.INFO, 'UI', 'UI initialized');
  }

  return {
    initialize,
    render,
    showPanel,
    hidePanel,
    updateStatus,
  };
})();
