// Settings persistence: a single JSON file, no native modules, no dependencies.
//
// There are no credentials to protect here — transcription runs on-device, so
// the app has no API keys, no account, and nothing secret to write down.
//
// The store is a factory over an explicit file path rather than reaching for
// Electron's userData directory itself. Electron is only available inside the
// app, and settings handling (corrupt files, upgrades, defaults) is exactly the
// sort of thing that should be testable without launching one.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  windowX: null,
  windowY: null,
  fontSize: 28,
  contentProtection: true,
  opacity: 0.86,
  lastScript: ''
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, over) {
  const out = { ...base };
  if (!isPlainObject(over)) return out;
  for (const key of Object.keys(over)) {
    if (isPlainObject(over[key]) && isPlainObject(base[key])) {
      out[key] = deepMerge(base[key], over[key]);
    } else if (over[key] !== undefined) {
      out[key] = over[key];
    }
  }
  return out;
}

function createStore(file) {
  let data = null;

  function load() {
    if (data) return data;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      raw = null; // missing, unreadable, or not valid JSON — defaults will do
    }
    // A settings file holding a string, a number or an array is not merely
    // useless, it is actively harmful: spreading its keys would graft "0", "1",
    // "2" onto the settings object. Anything that is not an object is discarded.
    if (!isPlainObject(raw)) raw = {};

    // An older build stored API keys here. Dropping them in memory is not
    // enough: upgrading has to erase them from disk, or a credential the app no
    // longer has any use for outlives the feature that needed it.
    const hadKeys = Object.prototype.hasOwnProperty.call(raw, 'apiKeys');
    if (hadKeys) delete raw.apiKeys;

    data = deepMerge(DEFAULTS, raw);
    if (hadKeys) save();
    return data;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
      return true;
    } catch {
      // A settings file that cannot be written is not worth crashing over: the
      // app works fine on in-memory settings, it just will not remember them.
      return false;
    }
  }

  return {
    getSettings() { return load(); },
    setSettings(patch) { load(); data = deepMerge(data, patch); save(); return data; },
    get file() { return file; }
  };
}

// The app-wide store, created on first use so that requiring this module does
// not require Electron.
let singleton = null;
function shared() {
  if (!singleton) {
    const { app } = require('electron');
    singleton = createStore(path.join(app.getPath('userData'), 'notchprompt-data.json'));
  }
  return singleton;
}

module.exports = {
  DEFAULTS,
  createStore,
  getSettings: () => shared().getSettings(),
  setSettings: (patch) => shared().setSettings(patch)
};
