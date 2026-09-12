/**
 * Tests for src/core/window.js — the Electron shell's windows.
 * Covers: kindOf classification, list, open (including the mouseup-only
 * button and the localized label lookup), close guards.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, list, open, close } from '../src/core/window.js';

const SHELL_URL = 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/window/index.html?x=1';
const LANDING_URL = 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/new-tab/index.html';
const CHART_URL = 'https://cn.tradingview.com/chart/tkxQ6d2w/';
const TOOLTIP_URL = 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/tooltip/index.html';

const page = (id, url, title = '') => ({ id, url, title, type: 'page' });

/**
 * Mock withPage. `pages` maps target id → { evalIn, input? }; `input`
 * collects the mouse events dispatched at that target.
 */
function mockWithPage(pages) {
  return async (id, fn) => {
    const p = pages[id];
    if (!p) throw new Error(`unreachable target ${id}`);
    p.input = p.input || [];
    const client = { Input: { dispatchMouseEvent: async (ev) => { p.input.push(ev); } } };
    return fn({ evalIn: p.evalIn, client });
  };
}

/** evalIn that answers by substring match, like the real page would. */
function evalBy(map) {
  return async (expr) => {
    for (const [key, val] of Object.entries(map)) {
      if (expr.includes(key)) return typeof val === 'function' ? val(expr) : val;
    }
    return undefined;
  };
}

describe('kindOf', () => {
  it('classifies shell, landing, chart and everything else', () => {
    assert.equal(kindOf(SHELL_URL), 'shell');
    assert.equal(kindOf(LANDING_URL), 'landing');
    assert.equal(kindOf(CHART_URL), 'chart');
    assert.equal(kindOf(TOOLTIP_URL), 'other');
    assert.equal(kindOf(''), 'other');
    assert.equal(kindOf(), 'other');
  });
});

describe('list', () => {
  it('counts only shells that actually have a tab bar, and flags visible pages', async () => {
    const targets = [
      page('shell1', SHELL_URL),
      page('shell2', SHELL_URL),          // helper view: no tabs in its DOM
      page('chart1', CHART_URL, 'Live stock charts on TradingView — BABA'),
      page('landing1', LANDING_URL, 'New tab'),
      page('tip', TOOLTIP_URL),
    ];
    const pages = {
      shell1: { evalIn: evalBy({ '.tabs-container': [{ title: '个股', active: true }] }) },
      shell2: { evalIn: evalBy({ '.tabs-container': [] }) },
      chart1: { evalIn: evalBy({ visibilityState: 'visible' }) },
      landing1: { evalIn: evalBy({ visibilityState: 'hidden' }) },
    };

    const res = await list({ _deps: { fetchTargets: async () => targets, withPage: mockWithPage(pages) } });

    assert.equal(res.success, true);
    assert.equal(res.window_count, 1);
    assert.equal(res.windows[0].shell_target_id, 'shell1');
    assert.equal(res.windows[0].tab_count, 1);

    // Tooltip target is not listed; chart and landing are.
    assert.deepEqual(res.pages.map((p) => p.target_id).sort(), ['chart1', 'landing1']);
    const chart = res.pages.find((p) => p.target_id === 'chart1');
    assert.equal(chart.kind, 'chart');
    assert.equal(chart.visible, true);
    assert.equal(chart.chart_id, 'tkxQ6d2w');
    assert.equal(res.pages.find((p) => p.target_id === 'landing1').visible, false);
  });

  it('survives a target that disappears mid-listing', async () => {
    const targets = [page('shell1', SHELL_URL), page('chart1', CHART_URL)];
    const pages = { shell1: { evalIn: evalBy({ '.tabs-container': [{ title: 'x', active: true }] }) } };
    const res = await list({ _deps: { fetchTargets: async () => targets, withPage: mockWithPage(pages) } });
    assert.equal(res.window_count, 1);
    assert.equal(res.pages[0].visible, false);   // unreachable → not visible, no throw
  });

  it('reports no windows rather than throwing when nothing is open', async () => {
    const res = await list({ _deps: { fetchTargets: async () => [], withPage: mockWithPage({}) } });
    assert.equal(res.success, false);
    assert.equal(res.window_count, 0);
  });
});

describe('open', () => {
  function openDeps({ buttonTitle = 'Open new window', appears = true, shellHasTabs = true } = {}) {
    const before = [page('shell1', SHELL_URL), page('chart1', CHART_URL)];
    const after = [...before, page('shell2', SHELL_URL), page('landing2', LANDING_URL)];
    let calls = 0;
    const pages = {
      shell1: {
        evalIn: evalBy({
          '.tabs-container': shellHasTabs,
          'navigator.language': 'zh-CN',
          '.action-button': buttonTitle === null ? null : { x: 1364, y: 17, title: buttonTitle },
        }),
      },
    };
    return {
      pages,
      deps: {
        fetchTargets: async () => (calls++ === 0 || !appears ? before : after),
        withPage: mockWithPage(pages),
        sleep: async () => {},
      },
    };
  }

  it('clicks with a real press/release, not element.click()', async () => {
    const { pages, deps } = openDeps();
    const res = await open({ wait_ms: 30, _deps: deps });

    assert.equal(res.success, true);
    assert.equal(res.clicked_in_shell, 'shell1');
    const types = pages.shell1.input.map((e) => e.type);
    assert.deepEqual(types, ['mouseMoved', 'mousePressed', 'mouseReleased']);
    const pressed = pages.shell1.input.find((e) => e.type === 'mousePressed');
    assert.equal(pressed.button, 'left');
    assert.equal(pressed.buttons, 1);
    assert.equal(pressed.x, 1364);
  });

  it('returns the new landing target to pin TV_TARGET_ID to', async () => {
    const { deps } = openDeps();
    const res = await open({ wait_ms: 30, _deps: deps });
    assert.equal(res.target_id, 'landing2');
    assert.equal(res.target_kind, 'landing');
    assert.equal(res.new_shell_target_id, 'shell2');
    assert.match(res.note, /layout_new/);
  });

  it('finds the button by a localized title', async () => {
    const { deps } = openDeps({ buttonTitle: '打开新窗口' });
    const res = await open({ wait_ms: 30, _deps: deps });
    assert.equal(res.success, true);
    assert.equal(res.button_title, '打开新窗口');
  });

  it('falls back to the non-main-menu action button when the title is unknown', async () => {
    const { deps } = openDeps({ buttonTitle: 'Ouvrir une nouvelle fenêtre' });
    const res = await open({ wait_ms: 30, _deps: deps });
    assert.equal(res.success, true);
  });

  it('throws when no shell window exists', async () => {
    await assert.rejects(
      open({ wait_ms: 30, _deps: { fetchTargets: async () => [page('chart1', CHART_URL)], withPage: mockWithPage({}), sleep: async () => {} } }),
      /shell window not found/i,
    );
  });

  it('throws when the button is missing', async () => {
    const { deps } = openDeps({ buttonTitle: null });
    await assert.rejects(open({ wait_ms: 30, _deps: deps }), /button not found/i);
  });

  it('throws when the shell has no tab bar', async () => {
    const { deps } = openDeps({ shellHasTabs: false });
    await assert.rejects(open({ wait_ms: 30, _deps: deps }), /button not found/i);
  });

  it('throws when no new window shows up', async () => {
    const { deps } = openDeps({ appears: false });
    await assert.rejects(open({ wait_ms: 30, _deps: deps }), /no new window target appeared/i);
  });
});

describe('close', () => {
  const twoWindows = [
    page('shell1', SHELL_URL), page('chart1', CHART_URL),
    page('shell2', SHELL_URL), page('landing2', LANDING_URL),
  ];

  function closeDeps(targets, { removes = true } = {}) {
    let closed = null;
    return {
      get closed() { return closed; },
      deps: {
        fetchTargets: async () => (closed && removes ? targets.filter((t) => t.id !== closed) : targets),
        closeTarget: async (id) => { closed = id; return 'Target is closing'; },
        sleep: async () => {},
      },
    };
  }

  it('requires a target_id', async () => {
    await assert.rejects(close({}), /target_id is required/);
  });

  it('rejects an unknown target', async () => {
    const { deps } = closeDeps(twoWindows);
    await assert.rejects(close({ target_id: 'nope', _deps: deps }), /not found/);
  });

  it('rejects a target that is not a TradingView window or chart', async () => {
    const { deps } = closeDeps([...twoWindows, page('tip', TOOLTIP_URL)]);
    await assert.rejects(close({ target_id: 'tip', _deps: deps }), /not a TradingView window/);
  });

  it('refuses to close the last window', async () => {
    const { deps } = closeDeps([page('shell1', SHELL_URL), page('chart1', CHART_URL)]);
    await assert.rejects(close({ target_id: 'shell1', _deps: deps }), /last TradingView window/);
  });

  it('closes a second window and reports the drop', async () => {
    const h = closeDeps(twoWindows);
    const res = await close({ target_id: 'shell2', _deps: h.deps });
    assert.equal(res.success, true);
    assert.equal(h.closed, 'shell2');
    assert.equal(res.windows_before, 2);
    assert.equal(res.windows_after, 1);
  });

  it('closes a chart page even when it is the only window', async () => {
    const h = closeDeps([page('shell1', SHELL_URL), page('chart1', CHART_URL)]);
    const res = await close({ target_id: 'chart1', _deps: h.deps });
    assert.equal(res.success, true);
    assert.equal(res.kind, 'chart');
  });

  it('reports close_requested when the target survives', async () => {
    const h = closeDeps(twoWindows, { removes: false });
    const res = await close({ target_id: 'shell2', _deps: h.deps });
    assert.equal(res.success, false);
    assert.equal(res.action, 'close_requested');
    assert.match(res.error, /still present/);
  });
});
