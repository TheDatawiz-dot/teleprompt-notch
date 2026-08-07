// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
//
// There are no credentials to protect here: transcription runs on-device, so the
// app has no API keys, no account, and nothing secret to write down.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'notchprompt-data.json');

const DEFAULTS = {
  windowX: null,
  windowY: null,
  fontSize: 28,
  contentProtection: true,
  opacity: 0.86,
  lastScript: ''
};

let data = null;

function deepMerge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function load() {
  if (data) return data;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { raw = {}; }
  // An older build stored API keys here. Dropping them in memory is not enough:
  // upgrading has to erase them from disk, or a credential the app no longer has
  // any use for outlives the feature that needed it.
  const hadKeys = !!(raw && raw.apiKeys);
  if (hadKeys) delete raw.apiKeys;
  data = deepMerge(DEFAULTS, raw);
  if (hadKeys) save();
  return data;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (e) { /* a settings file we cannot write is not worth crashing over */ }
}

module.exports = {
  getSettings() { return load(); },
  setSettings(patch) { load(); data = deepMerge(data, patch || {}); save(); return data; }
};
