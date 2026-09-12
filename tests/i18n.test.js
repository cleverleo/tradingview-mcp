/**
 * Tests for localized-label resolution against the TradingView app bundle.
 *
 * The translation table is read out of an installed TradingView, so the tests
 * that assert real translations only run where one is present; the fallback
 * behaviour — which is what protects callers on every other machine — is
 * asserted unconditionally.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t, labelsFor, loadStrings, _resetCache } from '../src/core/i18n.js';

function bundleInstalled() {
  const home = os.homedir();
  const candidates = process.platform === 'darwin'
    ? [
      '/Applications/TradingView.app/Contents/Resources/app.asar',
      path.join(home, 'Applications/TradingView.app/Contents/Resources/app.asar'),
    ]
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Programs/TradingView/resources/app.asar')]
      : ['/opt/TradingView/resources/app.asar'];
  return candidates.some(p => existsSync(p));
}

const hasBundle = bundleInstalled();

describe('i18n — fallback behaviour', () => {
  it('returns the English key unchanged when the string is not in the table', () => {
    _resetCache();
    assert.equal(t('__definitely not a TradingView string__', 'zh-CN'), '__definitely not a TradingView string__');
  });

  it('labelsFor yields a single entry when there is no distinct translation', () => {
    _resetCache();
    assert.deepEqual(labelsFor('__no such string__', 'zh-CN'), ['__no such string__']);
  });

  it('falls back to English for an unknown language', () => {
    _resetCache();
    const { locale } = loadStrings('xx-YY');
    assert.equal(locale, 'en');
  });

  it('treats a missing language as English', () => {
    _resetCache();
    assert.equal(t('Create', undefined), 'Create');
  });
});

describe('i18n — against an installed bundle', { skip: hasBundle ? false : 'TradingView is not installed' }, () => {
  it('resolves a Chinese locale to the zh_CN table', () => {
    _resetCache();
    const { locale, strings } = loadStrings('zh-CN');
    assert.equal(locale, 'zh_CN');
    assert.ok(Object.keys(strings).length > 100, 'expected a populated translation table');
  });

  it('translates shell strings the tab flow depends on', () => {
    _resetCache();
    for (const key of ['Create', 'My layout', 'New tab']) {
      const translated = t(key, 'zh-CN');
      assert.notEqual(translated, key, `expected "${key}" to be translated`);
    }
  });

  it('labelsFor offers both the English and the localized spelling', () => {
    _resetCache();
    const labels = labelsFor('Create', 'zh-CN');
    assert.equal(labels.length, 2);
    assert.equal(labels[0], 'Create');
    assert.notEqual(labels[1], 'Create');
  });

  it('leaves English installs matching on the English strings', () => {
    _resetCache();
    assert.equal(t('Create', 'en-US'), 'Create');
    assert.deepEqual(labelsFor('Create', 'en-US'), ['Create']);
  });

  it('caches the table across calls', () => {
    _resetCache();
    const first = loadStrings('zh-CN');
    const second = loadStrings('ja');
    assert.equal(second.locale, first.locale, 'expected the cached table, not a re-resolve');
  });
});
