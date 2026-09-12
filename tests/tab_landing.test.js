/**
 * Tests for findLandingTarget in src/core/tab.js.
 *
 * With two windows open there can be two layout pickers, and picking the
 * first one builds the layout in the wrong window. TV_TARGET_ID has to win
 * over the scan. PINNED_TARGET_ID is read when connection.js is first
 * evaluated, so each case sets the env var before its own fresh import.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const LANDING = 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/new-tab/index.html';
const CHART = 'https://cn.tradingview.com/chart/tkxQ6d2w/';
const page = (id, url, title = '') => ({ id, url, title, type: 'page' });

const realFetch = globalThis.fetch;
let targets = [];
before(() => { globalThis.fetch = async () => ({ json: async () => targets }); });
after(() => { globalThis.fetch = realFetch; });

describe('findLandingTarget with TV_TARGET_ID set', () => {
  let findLandingTarget;
  before(async () => {
    process.env.TV_TARGET_ID = 'second-window-landing';
    ({ findLandingTarget } = await import('../src/core/tab.js?case=pinned'));
  });
  after(() => { delete process.env.TV_TARGET_ID; });

  it('picks the pinned landing page over an earlier one', async () => {
    targets = [
      page('first-window-landing', LANDING, 'New tab'),
      page('second-window-landing', LANDING, 'New tab'),
    ];
    const t = await findLandingTarget();
    assert.equal(t.id, 'second-window-landing');
  });

  it('falls back to the scan when the pinned target is not a landing page', async () => {
    targets = [page('some-landing', LANDING), page('second-window-landing', CHART)];
    const t = await findLandingTarget();
    assert.equal(t.id, 'some-landing');
  });

  it('recognises a landing page by title when the URL does not match', async () => {
    targets = [page('second-window-landing', 'file:///weird/path.html', 'New tab')];
    const t = await findLandingTarget();
    assert.equal(t.id, 'second-window-landing');
  });

  it('returns null when there is no landing page at all', async () => {
    targets = [page('chart-only', CHART)];
    assert.equal(await findLandingTarget(), null);
  });
});

describe('findLandingTarget without TV_TARGET_ID', () => {
  let findLandingTarget;
  before(async () => {
    delete process.env.TV_TARGET_ID;
    ({ findLandingTarget } = await import('../src/core/tab.js?case=unpinned'));
  });

  it('takes the first landing page it finds', async () => {
    targets = [page('a', LANDING, 'New tab'), page('b', LANDING, 'New tab')];
    const t = await findLandingTarget();
    assert.equal(t.id, 'a');
  });

  it('prefers a URL match over a title match', async () => {
    targets = [page('title-only', 'file:///x.html', 'New tab'), page('url-match', LANDING)];
    const t = await findLandingTarget();
    assert.equal(t.id, 'url-match');
  });
});
