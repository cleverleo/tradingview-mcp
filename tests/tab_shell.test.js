/**
 * Tests for which window tab_close / tab_switch / tab_new click in
 * (src/core/tab.js) when several TradingView windows are open.
 *
 * Observed on Desktop 3.4.1: three windows with 2 / 1 / 1 tabs, TV_TARGET_ID
 * pinned to a chart page in the 2-tab window. The shell used to be the first
 * one /json/list reported, picked separately for the last-tab guard and for
 * the click — so the guard could pass on the 2-tab window while the click
 * closed the only tab of another. These cases build that app in memory.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeTab, switchTab, newTab } from '../src/core/tab.js';

const SHELL_URL = 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/window/index.html?x=1';
const LANDING_URL = 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/new-tab/index.html';

const at = (x, y, w = 1440, h = 843) => ({ x, y, w, h });
const chart = (page) => ({ page, url: `https://cn.tradingview.com/chart/${page}/`, title: '' });
const landing = (page) => ({ page, url: LANDING_URL, title: 'New tab' });

/**
 * An in-memory TradingView. Each window is a shell target plus its tabs'
 * page targets; a window's shell and the page it shows report the window's
 * bounds, and only that page is `visible`.
 *
 *   rotate           — shift /json/list order on every fetch
 *   closeRemovesPage — false keeps a closed tab's page target listed
 */
function app(spec, { rotate = false, closeRemovesPage = true } = {}) {
  const windows = spec.map((w) => ({ ...w, tabs: [...w.tabs], active: w.active ?? 0, lingering: [] }));
  const sessions = [];   // one per attach: { id, log }
  const followed = [];
  let refreshed = 0;
  let fetches = 0;
  let born = 0;

  const byShell = (id) => windows.find((w) => w.shell === id);
  const byPage = (id) => windows.find((w) => w.tabs.some((t) => t.page === id));

  function targets() {
    const all = windows.flatMap((w) => [
      { id: w.shell, type: 'page', url: SHELL_URL, title: '' },
      ...[...w.tabs, ...w.lingering].map((t) => ({ id: t.page, type: 'page', url: t.url, title: t.title })),
    ]);
    const n = rotate ? fetches % all.length : 0;
    fetches++;
    return [...all.slice(n), ...all.slice(0, n)];
  }

  const shellEval = (w, log) => async (expr) => {
    if (expr.includes('window.screenX')) return w.bounds;
    if (expr.includes('Array.prototype.map.call')) {
      return w.tabs.map((t, i) => ({ title: t.page, active: i === w.active }));
    }
    if (expr.includes('.tab.active')) {
      log.push('close');
      const [gone] = w.tabs.splice(w.active, 1);
      if (!closeRemovesPage) w.lingering.push(gone);
      w.active = Math.max(0, w.active - 1);
      return true;
    }
    if (expr.includes('create-new-tab')) {
      log.push('new-tab');
      w.tabs.push(landing(`landing-new-${++born}`));
      w.active = w.tabs.length - 1;
      return true;
    }
    const click = expr.match(/\.tab'\)\[(\d+)\]\.click\(\)/);
    if (click) {
      log.push(`click ${click[1]}`);
      w.active = Number(click[1]);
      return undefined;
    }
    if (expr.includes('.length')) {
      log.push('count');
      return w.tabs.length;
    }
    return undefined;
  };

  const pageEval = (id) => async (expr) => {
    const w = byPage(id);
    const showing = w.tabs[w.active]?.page === id;
    if (expr.includes('visibilityState')) return showing ? 'visible' : 'hidden';
    if (expr.includes('window.screenX')) return w.bounds;
    return undefined;
  };

  const withPage = async (id, fn) => {
    const log = [];
    sessions.push({ id, log });
    const w = byShell(id);
    if (w) return fn({ evalIn: shellEval(w, log) });
    if (!byPage(id)) throw new Error(`unreachable target ${id}`);
    return fn({ evalIn: pageEval(id) });
  };

  return {
    windows,
    sessions,
    followed,
    get refreshed() { return refreshed; },
    /** Everything but tab counting that happened in one shell. */
    actionsIn: (shell) => sessions.filter((s) => s.id === shell).flatMap((s) => s.log).filter((e) => e !== 'count'),
    deps: (pinnedTargetId) => ({
      pinnedTargetId,
      fetchTargets: async () => targets(),
      withPage,
      sleep: async () => {},
      getClient: async () => { refreshed++; },
      reconnectTo: async (id) => { followed.push(id); },
    }),
  };
}

/** The windows from the observation: 1 / 2 / 1 tabs, b2 showing in the middle one. */
const observed = () => [
  { shell: 'shellA', bounds: at(0, 30), tabs: [chart('a1')] },
  { shell: 'shellB', bounds: at(0, 64), tabs: [chart('b1'), chart('b2')], active: 1 },
  { shell: 'shellC', bounds: at(144, 784, 1152, 864), tabs: [chart('c1')] },
];

describe('closeTab with several windows', () => {
  it('closes the pinned page\'s tab in its own window, whatever /json/list lists first', async () => {
    const h = app(observed(), { rotate: true });
    const res = await closeTab({ _deps: h.deps('b2') });

    assert.equal(res.success, true);
    assert.equal(res.shell_target_id, 'shellB');
    assert.equal(res.tabs_before, 2);
    assert.equal(res.tabs_after, 1);
    assert.equal(res.closed_target_id, 'b2');
    assert.equal(res.pinned_page_closed, true);
    assert.deepEqual(h.actionsIn('shellA'), []);
    assert.deepEqual(h.actionsIn('shellC'), []);
    assert.deepEqual(h.windows[1].tabs.map((t) => t.page), ['b1']);
  });

  it('runs the last-tab guard and the click on one attach', async () => {
    const h = app(observed(), { rotate: true });
    await closeTab({ _deps: h.deps('b2') });
    const closing = h.sessions.filter((s) => s.log.includes('close'));
    assert.equal(closing.length, 1);
    assert.equal(closing[0].id, 'shellB');
    assert.deepEqual(closing[0].log, ['count', 'close', 'count']);
  });

  it('refuses the last tab of the pinned window even though another window has two', async () => {
    const h = app(observed(), { rotate: true });
    await assert.rejects(closeTab({ _deps: h.deps('a1') }), /last tab/);
    assert.equal(h.sessions.some((s) => s.log.includes('close')), false);
  });

  it('refuses when the pinned page is not the tab its window is showing', async () => {
    const h = app(observed());
    await assert.rejects(closeTab({ _deps: h.deps('b1') }), /not the tab its window is showing/);
    assert.equal(h.sessions.some((s) => s.log.includes('close')), false);
  });

  it('refuses to guess when two windows sit at the same bounds', async () => {
    const spec = observed();
    spec[2].bounds = at(0, 64);
    const h = app(spec);
    await assert.rejects(closeTab({ _deps: h.deps('b2') }), /same position and size/);
    assert.equal(h.sessions.some((s) => s.log.includes('close')), false);
  });

  it('refuses an unpinned close while several windows are open', async () => {
    const h = app(observed());
    await assert.rejects(closeTab({ _deps: h.deps(null) }), /TV_TARGET_ID is not set/);
    assert.equal(h.sessions.some((s) => s.log.includes('close')), false);
  });

  it('rejects a pinned id that is not open', async () => {
    const h = app(observed());
    await assert.rejects(closeTab({ _deps: h.deps('gone') }), /not found/);
  });

  it('still closes the active tab unpinned with a single window, and re-resolves the client', async () => {
    const h = app([{ shell: 'shellA', bounds: at(0, 30), tabs: [chart('a1'), chart('a2')], active: 1 }]);
    const res = await closeTab({ _deps: h.deps(null) });
    assert.equal(res.success, true);
    assert.equal(res.tabs_after, 1);
    assert.equal(res.closed_target_id, undefined);
    assert.equal(h.refreshed, 1);
  });

  it('closes the showing tab of a pinned shell id', async () => {
    const h = app(observed());
    const res = await closeTab({ _deps: h.deps('shellB') });
    assert.equal(res.success, true);
    assert.equal(res.shell_target_id, 'shellB');
    assert.equal(res.closed_target_id, undefined);
    assert.equal(h.refreshed, 0);
  });

  it('reports failure when a tab closed but the pinned page is still there', async () => {
    const h = app(observed(), { closeRemovesPage: false });
    const res = await closeTab({ _deps: h.deps('b2') });
    assert.equal(res.success, false);
    assert.equal(res.pinned_page_closed, false);
    assert.match(res.error, /still open/);
  });
});

describe('switchTab with several windows', () => {
  // tab_list order here: a1 0, b1 1, b2 2, c1 3, c2 4
  const twoByTwo = () => {
    const spec = observed();
    spec[2].tabs = [chart('c1'), chart('c2')];
    return spec;
  };

  it('clicks only in the pinned page\'s window', async () => {
    const h = app(twoByTwo());
    const res = await switchTab({ index: 1, _deps: h.deps('b2') });
    assert.equal(res.success, true);
    assert.equal(res.tab_id, 'b1');
    assert.equal(h.windows[1].active, 0);
    assert.deepEqual(h.actionsIn('shellA'), []);
    assert.deepEqual(h.actionsIn('shellC'), []);
    assert.deepEqual(h.followed, ['b1']);
  });

  it('does not reach into another window for a tab that lives there', async () => {
    const h = app(twoByTwo());
    await assert.rejects(switchTab({ index: 4, _deps: h.deps('b2') }), /only switches within that page's window \(shellB\)/);
    assert.deepEqual(h.actionsIn('shellC'), []);
    assert.equal(h.windows[2].active, 0);
    assert.deepEqual(h.followed, []);
  });
});

describe('newTab with several windows', () => {
  const withPicker = () => [
    { shell: 'shellA', bounds: at(0, 30), tabs: [landing('pickerA')] },
    { shell: 'shellB', bounds: at(0, 64), tabs: [chart('b1')] },
  ];

  it('opens the tab in the pinned page\'s window instead of reusing a picker in another', async () => {
    const h = app(withPicker());
    const res = await newTab({ _deps: h.deps('b1') });
    assert.equal(res.success, true);
    assert.equal(res.target_id, 'landing-new-1');
    assert.deepEqual(h.actionsIn('shellB'), ['new-tab']);
    assert.deepEqual(h.actionsIn('shellA'), []);
  });

  it('reuses the pinned picker without clicking anything', async () => {
    const h = app(withPicker());
    const res = await newTab({ _deps: h.deps('pickerA') });
    assert.equal(res.success, true);
    assert.equal(res.target_id, 'pickerA');
    assert.deepEqual(h.actionsIn('shellA'), []);
    assert.deepEqual(h.actionsIn('shellB'), []);
  });
});
