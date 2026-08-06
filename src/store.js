// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
//
// API keys are the one thing here worth protecting: everything else is cosmetic,
// but a leaked Deepgram or OpenAI key is billable. They are encrypted at rest
// with Electron's safeStorage, which is backed by the login Keychain on macOS,
// so the settings file on disk never contains a usable credential.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const FILE = path.join(app.getPath('userData'), 'notchprompt-data.json');
const KEY_NAMES = ['deepgram', 'openai'];

const DEFAULTS = {
  apiKeys: { deepgram: '', openai: '' },
  windowX: null,
  windowY: null,
  fontSize: 28,
  contentProtection: true,
  opacity: 0.86,
  lastScript: ''
};

let data = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function encryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

// On disk a key is either {"$enc": "<base64>"} or, when the platform has no
// keychain to lean on, a bare string. Reading tolerates both so a settings file
// written on one machine never hard-fails on another.
function decodeKey(stored) {
  if (!stored) return '';
  if (typeof stored === 'string') return stored;
  if (typeof stored === 'object' && typeof stored.$enc === 'string') {
    try { return safeStorage.decryptString(Buffer.from(stored.$enc, 'base64')); }
    catch { return ''; } // wrong machine, rotated keychain — treat as unset
  }
  return '';
}

function encodeKey(plain) {
  if (!plain) return '';
  if (!encryptionAvailable()) return plain;
  try { return { $enc: safeStorage.encryptString(plain).toString('base64') }; }
  catch { return plain; }
}

function load() {
  if (data) return data;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { raw = {}; }
  data = deepMerge(DEFAULTS, raw);
  const stored = (raw && raw.apiKeys) || {};
  data.apiKeys = {};
  KEY_NAMES.forEach((name) => { data.apiKeys[name] = decodeKey(stored[name]); });
  return data;
}

function save() {
  const onDisk = { ...data, apiKeys: {} };
  KEY_NAMES.forEach((name) => { onDisk.apiKeys[name] = encodeKey(data.apiKeys[name]); });
  try {
    fs.writeFileSync(FILE, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  } catch (e) { /* a settings file we cannot write is not worth crashing over */ }
}

module.exports = {
  getSettings() { return load(); },
  setSettings(patch) { load(); data = deepMerge(data, patch || {}); save(); return data; },
  // The renderer only ever needs to know *whether* a key is set, never its value.
  keyPresence() {
    load();
    const out = {};
    KEY_NAMES.forEach((name) => { out[name] = !!data.apiKeys[name]; });
    return out;
  },
  encryptionAvailable
};
