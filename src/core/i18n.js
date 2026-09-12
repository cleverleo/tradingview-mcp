/**
 * Localized-label resolution for the TradingView Desktop shell.
 *
 * The Electron shell (tab bar, new-tab landing page, its dialogs) renders in
 * the user's TradingView language, so selectors that match on English button
 * text or aria-labels only ever work on an English install. TradingView ships
 * the translations it uses inside the app bundle at
 * `resources/locales/<locale>.json`, keyed by the *English* string:
 *
 *   en.json     { "New tab": "New tab",  "Create": "Create",  ... }
 *   zh_CN.json  { "New tab": "新标签页", "Create": "创建",     ... }
 *
 * So `t('Create')` turns an English key into whatever the running app shows,
 * and `labelsFor('Create')` gives every spelling worth matching against.
 *
 * Pass the page's `navigator.language` in as `language` — read it over CDP
 * rather than from the host OS, since the UI language is a TradingView account
 * setting and regularly differs from the system locale.
 *
 * Scope: this covers the desktop shell only. The chart itself is the web app,
 * whose strings are not in this bundle — match those with `data-name`
 * attributes, which are locale-independent.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

// navigator.language values that don't simply map to a locale file name.
const LOCALE_ALIASES = { ko: 'kr', pt: 'br', he: 'he_IL', ar: 'ar_AE' };

let cache = null; // { locale, strings } — resolved once per process.

/** Candidate `Resources`/`resources` directories for an installed TradingView. */
function resourceDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/TradingView.app/Contents/Resources',
      path.join(home, 'Applications/TradingView.app/Contents/Resources'),
    ];
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    return [path.join(base, 'Programs/TradingView/resources'), path.join(base, 'TradingView/resources')];
  }
  return ['/opt/TradingView/resources', '/usr/lib/tradingview/resources'];
}

/** Read and parse an asar archive's JSON directory header. */
function readAsarHeader(fd) {
  const sizes = Buffer.alloc(16);
  fs.readSync(fd, sizes, 0, 16, 0);
  const jsonLen = sizes.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  return {
    header: JSON.parse(jsonBuf.toString('utf8')),
    // File payloads follow the header, padded to a 4-byte boundary; each
    // entry's `offset` is relative to that base.
    base: 16 + jsonLen + ((4 - (jsonLen % 4)) % 4),
  };
}

/** Read one file out of an asar archive, or null when it isn't there. */
function readAsarFile(asarPath, innerPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const { header, base } = readAsarHeader(fd);
    let node = header;
    for (const part of innerPath.split('/')) {
      node = node?.files?.[part];
      if (!node) return null;
    }
    if (node.size == null || node.offset == null) return null;

    const out = Buffer.alloc(node.size);
    fs.readSync(fd, out, 0, node.size, base + Number(node.offset));
    return out.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Locale file names the bundle actually ships, without the .json suffix. */
function listLocales(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const { header } = readAsarHeader(fd);
    const dir = header?.files?.resources?.files?.locales?.files || {};
    return Object.keys(dir).map(n => n.replace(/\.json$/, ''));
  } catch {
    return ['en'];
  } finally {
    fs.closeSync(fd);
  }
}

/** Pick the locale file that best matches a `navigator.language` value. */
function pickLocaleFile(available, language) {
  if (!language) return 'en';
  const lower = String(language).replace('-', '_').toLowerCase();

  const exact = available.find(n => n.toLowerCase() === lower);
  if (exact) return exact;

  const short = lower.split('_')[0];
  if (LOCALE_ALIASES[short] && available.includes(LOCALE_ALIASES[short])) return LOCALE_ALIASES[short];

  // "de" -> de_DE, "zh" -> zh_CN (first match wins; en.json is the fallback).
  const prefixed = available.find(n => n.toLowerCase() === short || n.toLowerCase().startsWith(short + '_'));
  return prefixed || 'en';
}

/**
 * Load the running app's translation table.
 *
 * Failures are non-fatal — an empty table degrades to English-only matching,
 * which is exactly the behaviour callers had before.
 */
export function loadStrings(language) {
  if (cache) return cache;

  for (const dir of resourceDirs()) {
    const asar = path.join(dir, 'app.asar');
    if (!fs.existsSync(asar)) continue;
    try {
      // Probe en.json first: if the bundle doesn't have the expected layout,
      // move on to the next install candidate rather than caching an empty table.
      if (!readAsarFile(asar, 'resources/locales/en.json')) continue;
      const file = pickLocaleFile(listLocales(asar), language);
      const raw = readAsarFile(asar, `resources/locales/${file}.json`);
      cache = { locale: file, strings: raw ? JSON.parse(raw) : {} };
      return cache;
    } catch {
      // Corrupt or unexpected bundle layout — try the next candidate.
    }
  }

  cache = { locale: 'en', strings: {} };
  return cache;
}

/** Translate an English UI string into the running app's language. */
export function t(englishKey, language) {
  return loadStrings(language).strings[englishKey] || englishKey;
}

/**
 * Every spelling of `englishKey` worth matching a DOM node against —
 * the English original plus the localized form, deduplicated.
 */
export function labelsFor(englishKey, language) {
  const localized = t(englishKey, language);
  return localized === englishKey ? [englishKey] : [englishKey, localized];
}

/** Reset the cached table. Tests only. */
export function _resetCache() {
  cache = null;
}
