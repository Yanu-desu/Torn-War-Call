// Torn War Call - Config module
// Centralized configuration with validation and persistence.
// Provides defaults, loads from GM storage, and validates required fields.

window.TWC = window.TWC || {};

window.TWC.Config = (function () {
  'use strict';

  const VERSION = '2.0.0';
  const BUILD_DATE = '2026-08-07';

  // Schema: { key, type, default, required }
  const SCHEMA = [
    { key: 'apiKey', type: 'string', default: '', required: true },
    { key: 'ownFactionId', type: 'string', default: '', required: true },
    { key: 'enemyFactionId', type: 'string', default: '', required: false },
    { key: 'warStatusPollIntervalMs', type: 'number', default: 30000, required: false },
    { key: 'hospitalPollIntervalMs', type: 'number', default: 12000, required: false },
    { key: 'warnWindowSeconds', type: 'number', default: 60, required: false },
    { key: 'panelWidth', type: 'number', default: 400, required: false },
    { key: 'panelHeight', type: 'number', default: 500, required: false },
    { key: 'panelCollapsed', type: 'boolean', default: false, required: false },
    { key: 'panelHidden', type: 'boolean', default: false, required: false },
    { key: 'lastInitTime', type: 'number', default: 0, required: false },
  ];

  let config = {};

  function load() {
    SCHEMA.forEach((field) => {
      const stored = GM_getValue(`twc_${field.key}`);
      config[field.key] = stored !== undefined ? stored : field.default;
    });
  }

  function save(key, value) {
    config[key] = value;
    GM_setValue(`twc_${key}`, value);
  }

  function get(key) {
    return key ? config[key] : { ...config };
  }

  function validate() {
    const errors = [];
    SCHEMA.forEach((field) => {
      if (field.required && !config[field.key]) {
        errors.push(`Missing required setting: ${field.key}`);
      }
      if (config[field.key] && typeof config[field.key] !== field.type) {
        errors.push(`Invalid type for ${field.key}: expected ${field.type}, got ${typeof config[field.key]}`);
      }
    });
    return errors;
  }

  function exportConfig() {
    return {
      version: VERSION,
      exported: new Date().toISOString(),
      data: { ...config },
    };
  }

  function importConfig(json) {
    try {
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      if (!parsed.data || typeof parsed.data !== 'object') {
        throw new Error('Invalid export: missing data field');
      }
      Object.entries(parsed.data).forEach(([key, value]) => {
        if (SCHEMA.find((f) => f.key === key)) {
          save(key, value);
        }
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  return {
    VERSION,
    BUILD_DATE,
    load,
    save,
    get,
    validate,
    exportConfig,
    importConfig,
  };
})();
