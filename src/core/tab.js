/**
 * Core tab management logic.
 *
 * TradingView Desktop's tab bar lives in a separate Electron shell window
 * (app/window/index.html), not in the chart pages themselves. CDP-level
 * activation (/json/activate) and synthesized Ctrl+T/Ctrl+W key events do
 * not drive it (Electron accelerators don't fire from CDP input), so tab
 * switching/creation/closing click the shell window's DOM directly:
 * `.tabs-container .tab`, its close button, and `create-new-tab-button`.
 * (Approach from issue #155 and PR #163, verified on Desktop 3.1.0.)
 *
 * Every window has its own shell, so "the" tab bar stops being one thing as
 * soon as a second window is open. Tab operations pick their shell once, in
 * pickShell(): the window the TV_TARGET_ID page lives in when that is set,
 * otherwise the first tab bar there is.
 */
import CDP from 'chrome-remote-interface';
import { labelsFor } from './i18n.js';
import { shellFor, tabBarShells } from './window.js';
import { getClient, reconnectTo, CDP_HOST, CDP_PORT, PINNED_TARGET_ID } from '../connection.js';

const TAB_COUNT = `document.querySelectorAll('.tabs-container .tab').length`;
const LANDING_RE = /\/app\/new-tab\//i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  return resp.json();
}

/** Run fn with an eval helper attached to a specific target. */
async function withTarget(targetId, fn) {
  let c = null;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    return await fn(async (expression) => {
      const { result } = await c.Runtime.evaluate({ expression, returnByValue: true });
      return result?.value;
    });
  } finally {
    try { if (c) await c.close(); } catch { /* already gone */ }
  }
}

/**
 * Test seams, same shape as window.js's (`fetchTargets`, `withPage`) so one
 * `_deps` object drives both modules. The tools and the CLI never pass it.
 */
function resolve(deps) {
  return {
    fetchTargets: deps?.fetchTargets || fetchTargets,
    attach: deps?.withPage
      ? (id, fn) => deps.withPage(id, ({ evalIn }) => fn(evalIn))
      : withTarget,
    pinned: deps && 'pinnedTargetId' in deps ? deps.pinnedTargetId : PINNED_TARGET_ID,
    sleep: deps?.sleep || sleep,
    getClient: deps?.getClient || getClient,
    reconnectTo: deps?.reconnectTo || reconnectTo,
  };
}

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list({ _deps } = {}) {
  const { fetchTargets: getTargets } = resolve(_deps);
  const targets = await getTargets();

  // Chart tabs plus new-tab landing pages (layout picker), so every tab in the
  // top bar is listable and switchable.
  const tabs = targets
    .filter(t => t.type === 'page' && (/tradingview\.com\/chart/i.test(t.url) || t.title === 'New tab'))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
      is_chart: /tradingview\.com\/chart/i.test(t.url),
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Choose the tab-bar shell a tab operation clicks in. Called once per
 * operation, and every step after it (count, click, recount) runs against
 * the shell it returns — re-picking from /json/list between steps is how the
 * last-tab guard once passed on a 2-tab window while the click landed in a
 * 1-tab one.
 *
 * With TV_TARGET_ID set this is the window that page lives in; shellFor()
 * throws rather than guess when that can't be pinned to exactly one window.
 * Without it, the first tab bar found — only unambiguous with one window
 * open, so `window_count` goes back to the caller to decide.
 */
async function pickShell(deps) {
  const { pinned } = resolve(deps);
  if (pinned) {
    return { ...(await shellFor(pinned, { _deps: deps })), pinned, window_count: null };
  }
  const shells = await tabBarShells({ _deps: deps });
  if (!shells.length) {
    throw new Error('TradingView shell window (tab bar) not found. Is this TradingView Desktop with tabs?');
  }
  return { ...shells[0], page_kind: null, page_visible: null, pinned: null, window_count: shells.length };
}

/** Whether two page targets belong to the same window; false when unsure. */
async function sameWindow(a, b, deps) {
  try {
    const [ownerA, ownerB] = [await shellFor(a, { _deps: deps }), await shellFor(b, { _deps: deps })];
    return ownerA.shell_target_id === ownerB.shell_target_id;
  } catch {
    return false;
  }
}

/** Check whether a CDP page target is the visible one. */
async function isTargetVisible(attach, targetId) {
  try {
    return (await attach(targetId, (evalIn) => evalIn('document.visibilityState'))) === 'visible';
  } catch {
    return false;
  }
}

const isLanding = (t) => t.type === 'page'
  && (LANDING_RE.test(t.url || '') || t.title === 'New tab');

/**
 * Find an open new-tab landing page target (shows the layout picker).
 *
 * With a second window open there can be several landing pages, and taking
 * the first one means building the layout in the wrong window. TV_TARGET_ID —
 * which is exactly what window_open hands back — settles it; the scan is the
 * fallback for the single-window case.
 */
export async function findLandingTarget({ _deps } = {}) {
  const { fetchTargets: getTargets, pinned } = resolve(_deps);
  const targets = await getTargets();
  // Match on the landing page's URL, not its title: the title is localized
  // (zh: "新标签页"), so a title comparison only ever works in English.
  if (pinned) {
    const hit = targets.find(t => t.id === pinned && isLanding(t));
    if (hit) return hit;
  }
  return targets.find(t => t.type === 'page' && LANDING_RE.test(t.url || ''))
    || targets.find(t => t.type === 'page' && t.title === 'New tab')
    || null;
}

/**
 * Open a new chart tab by clicking the shell window's new-tab button.
 * With `layout`, also picks from the landing page's layout list:
 *   layout: 'new'    -> click "Create new layout" (blank chart, saved as Unnamed)
 *   layout: '<name>' -> open the saved layout whose title contains <name>
 * Reuses an already-open landing tab instead of opening another one.
 */
export async function newTab({ layout, name, _deps } = {}) {
  const { fetchTargets: getTargets, attach, pinned, sleep: wait, reconnectTo: follow } = resolve(_deps);
  let landing = await findLandingTarget({ _deps });
  let shellCounts = null;

  // Pinned to something other than a picker (a chart page, say), the scan can
  // turn up a picker in some other window. Reusing it would put the layout
  // there, so only take it when it is provably in the pinned page's window.
  if (landing && pinned && landing.id !== pinned && !(await sameWindow(pinned, landing.id, _deps))) {
    landing = null;
  }

  if (!landing) {
    const shell = await pickShell(_deps);
    const idsBefore = new Set((await getTargets()).map(t => t.id));
    shellCounts = await attach(shell.shell_target_id, async (evalIn) => {
      const before = await evalIn(TAB_COUNT);
      const clicked = await evalIn(`
        (function() {
          // The real button (.create-new-tab-button) has to be tried first:
          // [class*="create-new-tab"] matches the wrapping
          // .create-new-tab-button-container earlier in document order, and
          // clicking that container does nothing.
          var btn = document.querySelector('.create-new-tab-button')
            || document.querySelector('[class*="create-new-tab"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      if (!clicked) throw new Error('New-tab button not found in shell window.');
      await wait(1500);
      const after = await evalIn(TAB_COUNT);
      return { before, after };
    });
    // The picker this click opened is the one that wasn't there before it.
    // A rescan would take whichever picker lists first, in any window.
    landing = (await getTargets()).find(t => !idsBefore.has(t.id) && isLanding(t))
      || (pinned ? null : await findLandingTarget({ _deps }));
  }

  if (!layout) {
    const state = await list({ _deps });
    return {
      success: shellCounts ? shellCounts.after > shellCounts.before : !!landing,
      action: 'new_tab_opened',
      target_id: landing?.id || null,
      note: 'Tab is on the layout picker. Call tab_new with layout: "new" or a saved layout name to open a chart in it — pin it with TV_TARGET_ID=<target_id> so the layout lands in this tab.',
      ...state,
    };
  }

  if (!landing) throw new Error('New tab opened but its landing page target was not found.');

  // Snapshot existing chart targets so we can spot the one the pick creates.
  const chartIdsBefore = new Set(
    (await getTargets())
      .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
      .map(t => t.id)
  );

  const wantNew = String(layout).trim().toLowerCase() === 'new';
  const layoutName = name || 'New layout';
  const picked = await attach(landing.id, async (evalIn) => {
    if (wantNew) {
      // The landing page renders in the app's language, so the name field's
      // placeholder and the Create button's text are both translated. Resolve
      // them through the app's own locale bundle instead of assuming English.
      const language = await evalIn('navigator.language');
      const namePlaceholders = labelsFor('My layout', language);
      const createLabels = labelsFor('Create', language).map(l => l.toLowerCase());

      // "Create new layout" opens a naming dialog; the Create button stays
      // disabled until the name input is filled (React controlled input, so
      // the native value setter + input event are required).
      await evalIn(`(function(){ var b = document.querySelector('.create-new-layout-button'); if (b) b.click(); })()`);
      await wait(700);
      const filled = await evalIn(`
        (function() {
          // The dialog's name field, not the landing page's Search box. This
          // page has no [role="dialog"]/[class*="dialog"] wrapper to scope to,
          // so match the placeholder, then fall back to the last visible text
          // input — the one the dialog just added.
          var wanted = ${JSON.stringify(namePlaceholders)};
          var inputs = Array.prototype.slice.call(document.querySelectorAll('input'))
            .filter(function(e) { return e.offsetParent !== null; });
          var inp = inputs.filter(function(e) { return wanted.indexOf(e.placeholder) !== -1; })[0]
            || inputs[inputs.length - 1];
          if (!inp) return 'no-dialog-input';
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${JSON.stringify(name || 'New layout')});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filled';
        })()
      `);
      if (filled !== 'filled') throw new Error(`Create-layout dialog did not open as expected (${filled}).`);
      await wait(400);
      const created = await evalIn(`
        (function() {
          var wanted = ${JSON.stringify(createLabels)};
          var btns = document.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').trim().toLowerCase();
            if (wanted.indexOf(t) !== -1 && !btns[i].disabled) { btns[i].click(); return true; }
          }
          return false;
        })()
      `);
      if (!created) throw new Error('Create button not found or still disabled in the layout dialog.');
      return layoutName;
    }
    const clickByTitle = `
      (function() {
        var q = ${JSON.stringify(String(layout).toLowerCase())};
        var items = document.querySelectorAll('.layout-list-item');
        for (var i = 0; i < items.length; i++) {
          var t = items[i].querySelector('.layout-list-item-title');
          if (t && t.textContent.trim().toLowerCase().indexOf(q) !== -1) {
            items[i].click();
            return t.textContent.trim();
          }
        }
        return null;
      })()
    `;
    let foundTitle = await evalIn(clickByTitle);
    if (!foundTitle) {
      // Not in the recents — expand the full layout list and retry.
      await evalIn(`(function(){ var b = document.querySelector('.layout-list-expand-button'); if (b) b.click(); })()`);
      await wait(800);
      foundTitle = await evalIn(clickByTitle);
    }
    return foundTitle;
  });

  if (!picked) throw new Error(`Layout matching "${layout}" not found in the layout list.`);

  // The chart loads under a NEW CDP target: the file:// landing -> https://
  // chart navigation swaps renderer processes, so the target id changes.
  // Wait for a chart target that wasn't there before the pick.
  let chartTarget = null;
  for (let i = 0; i < 30; i++) {
    await wait(500);
    const targets = await getTargets();
    chartTarget = targets.find(x =>
      x.type === 'page' && /tradingview\.com\/chart/i.test(x.url) && !chartIdsBefore.has(x.id)
    ) || targets.find(x => x.id === landing.id && /tradingview\.com\/chart/i.test(x.url)) || null;
    if (chartTarget) break;
  }
  if (!chartTarget) throw new Error(`Picked "${picked}" but no new chart target appeared.`);

  // Give the chart a moment to boot, then follow it.
  await wait(2000);
  await follow(chartTarget.id);
  // The landing page navigated to a chart, which swapped renderer processes:
  // the target id the caller pinned is gone and this is its replacement. Hand
  // it back so the next call can pin to it without re-listing the windows.
  return {
    success: true,
    action: wantNew ? 'new_layout_created' : 'layout_opened_in_new_tab',
    layout: picked,
    target_id: chartTarget.id,
    chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    note: 'target_id replaces the layout-picker target you pinned — use TV_TARGET_ID=<target_id> from here on.',
  };
}

/**
 * Close the active tab of one window by clicking its close button in the shell.
 *
 * Which window: the TV_TARGET_ID page's, and that page has to be the tab its
 * window is showing — so the tab that closes is the pinned one, never a
 * neighbour. Unpinned, only while a single window is open: with several, the
 * tab that goes would be in whichever window /json/list happens to list first.
 */
export async function closeTab({ _deps } = {}) {
  const { fetchTargets: getTargets, attach, sleep: wait, getClient: refresh } = resolve(_deps);
  const shell = await pickShell(_deps);
  const closesPinnedPage = !!shell.pinned && shell.page_kind !== 'shell';

  if (closesPinnedPage && !shell.page_visible) {
    throw new Error(`The TV_TARGET_ID page (${shell.pinned}) is not the tab its window is showing, and tab_close closes the showing tab. Switch to it first, or pin the visible page from window_list.`);
  }
  if (!shell.pinned && shell.window_count > 1) {
    throw new Error(`${shell.window_count} TradingView windows are open and TV_TARGET_ID is not set, so there is no telling which window would lose a tab. Pin a page from window_list.`);
  }

  // Guard, click and recount on one client, in the shell picked above.
  const { before, after } = await attach(shell.shell_target_id, async (evalIn) => {
    const count = await evalIn(TAB_COUNT);
    if (!(count > 1)) {
      throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
    }
    const clicked = await evalIn(`
      (function() {
        // Pinned, only the active tab will do: it is the pinned page's tab.
        var active = document.querySelector('.tabs-container .tab.active')${shell.pinned ? '' : ` || document.querySelectorAll('.tabs-container .tab')[0]`};
        if (!active) return false;
        // The close container div has no handler — the real clickable is the button inside it.
        var close = active.querySelector('[class*="close"] button') || active.querySelector('button[class*="close"]') || active.querySelector('[class*="close"]');
        if (!close) return false;
        close.click();
        return true;
      })()
    `);
    if (!clicked) throw new Error('Close button not found on the active tab.');
    await wait(1000);
    return { before: count, after: await evalIn(TAB_COUNT) };
  });

  const result = {
    success: after < before,
    action: 'tab_closed',
    shell_target_id: shell.shell_target_id,
    tabs_before: before,
    tabs_after: after,
  };

  if (closesPinnedPage) {
    // Confirm the tab that went is the pinned page. The tab count drops
    // before the page target is torn down, so give it a moment.
    let gone = false;
    for (let i = 0; i < 5 && !gone; i++) {
      gone = !(await getTargets()).some(t => t.id === shell.pinned);
      if (!gone) await wait(400);
    }
    result.closed_target_id = shell.pinned;
    result.pinned_page_closed = gone;
    if (!gone) {
      result.success = false;
      result.error = `A tab closed, but the TV_TARGET_ID page (${shell.pinned}) is still open. Check window_list.`;
    } else {
      result.note = 'TV_TARGET_ID pointed at the tab that just closed. Re-pin from window_list before the next call.';
    }
  } else if (!shell.pinned) {
    // Our cached CDP client may have been attached to the closed tab — re-resolve.
    // (Pinned, connect() only ever goes back to the pin, so there is nothing to re-resolve.)
    try { await refresh(); } catch { /* next tool call will reconnect */ }
  }

  return result;
}

/**
 * Switch to a chart tab by index (from tab_list). Clicks the corresponding
 * tab in the shell window so the switch is visible, verifies the desired
 * chart target actually became visible, then re-attaches the CDP client so
 * subsequent reads follow it.
 *
 * With TV_TARGET_ID set, the clicking happens only in that page's window.
 */
export async function switchTab({ index, _deps } = {}) {
  const { attach, sleep: wait, reconnectTo: follow } = resolve(_deps);
  const tabs = await list({ _deps });
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  if (!(await isTargetVisible(attach, target.id))) {
    const shell = await pickShell(_deps);
    const clicked = await attach(shell.shell_target_id, async (evalIn) => {
      const count = await evalIn(TAB_COUNT);
      // Try the same ordinal first (shell order usually matches), then the rest.
      const order = [...new Set([Math.min(idx, count - 1), ...Array.from({ length: count }, (_, k) => k)])];
      for (const k of order) {
        await evalIn(`document.querySelectorAll('.tabs-container .tab')[${k}].click()`);
        await wait(400);
        if (await isTargetVisible(attach, target.id)) return k;
      }
      return null;
    });
    if (clicked === null) {
      throw new Error(`Clicked through all shell tabs but chart ${target.chart_id} never became visible.`
        + (shell.pinned ? ` With TV_TARGET_ID set, tab_switch only switches within that page's window (${shell.shell_target_id}).` : ''));
    }
  }

  // Re-attach the cached CDP client so subsequent reads follow the switch.
  try {
    await follow(target.id);
  } catch (e) {
    throw new Error(`Tab is visible but failed to re-attach CDP to it: ${e.message}`);
  }

  return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id, visually_switched: true };
}
