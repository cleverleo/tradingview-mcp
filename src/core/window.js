/**
 * Core window management — the Electron shell's own windows, not chart tabs.
 *
 * Every other module drives the chart page inside whatever window happens to
 * be there. This one deals with the windows themselves, so a scratch window
 * can absorb the UI side effects that other tools cause — panels opening
 * (watchlist, Strategy Tester, Pine editor), symbol switches, indicator
 * visibility toggles — instead of disturbing the chart the user is watching.
 *
 * Workflow: window_open → note the returned target id → run everything else
 * with TV_TARGET_ID set to it (see PINNED_TARGET_ID in connection.js), so
 * reads and writes land in that window. Several windows can be driven in
 * parallel this way, one target id each.
 *
 * Caveat worth repeating to callers: a window isolates the INTERFACE, not
 * account content. Layouts, watchlists, alerts and Pine scripts live on
 * TradingView's servers and are shared by every window, so anything that
 * changes layout content (symbol, timeframe, studies, drawings) still writes
 * back to whichever layout the scratch window has open. Give the scratch
 * window its own layout (layout_new) before making those changes.
 */
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT } from '../connection.js';
import { labelsFor } from './i18n.js';

const SHELL_RE = /\/window\/index\.html/i;
const LANDING_RE = /\/app\/new-tab\//i;
const CHART_RE = /tradingview\.com\/chart/i;
const TAB_SELECTOR = '.tabs-container .tab';
const OPEN_WAIT_MS = 12000;
const POLL_MS = 400;

export function kindOf(url = '') {
  if (CHART_RE.test(url)) return 'chart';
  if (LANDING_RE.test(url)) return 'landing';
  if (SHELL_RE.test(url)) return 'shell';
  return 'other';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  return resp.json();
}

/** Attach to one page target and hand `fn` an eval helper plus the client. */
async function withPage(targetId, fn) {
  let c = null;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    const evalIn = async (expression) => {
      const { result } = await c.Runtime.evaluate({ expression, returnByValue: true });
      return result?.value;
    };
    return await fn({ evalIn, client: c });
  } finally {
    try { if (c) await c.close(); } catch { /* already gone */ }
  }
}

function resolve(deps) {
  return {
    fetchTargets: deps?.fetchTargets || fetchTargets,
    withPage: deps?.withPage || withPage,
    closeTarget: deps?.closeTarget || (async (id) => {
      const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/close/${id}`);
      return resp.text();
    }),
    sleep: deps?.sleep || sleep,
  };
}

async function pageTargets(fetchFn) {
  const all = await fetchFn();
  return (all || []).filter((t) => t.type === 'page');
}

const chartIdOf = (url = '') => url.match(/\/chart\/([^/?]+)/)?.[1] || null;

/**
 * List the open windows and every chart / layout-picker page behind them.
 *
 * A window's own tab bar lives in its shell target, so shells are what get
 * counted as windows. Which chart page belongs to which window can't be read
 * off the target list — but each window shows exactly one tab at a time, so
 * the pages marked `visible` are the current tab of some window, and those
 * are the ids worth pinning TV_TARGET_ID to.
 */
export async function list({ _deps } = {}) {
  const { fetchTargets: getTargets, withPage: attach } = resolve(_deps);
  const targets = await pageTargets(getTargets);

  const windows = [];
  const pages = [];

  for (const t of targets) {
    const kind = kindOf(t.url);

    if (kind === 'shell') {
      // Several targets share the shell URL (tooltip layers, helper views);
      // the real tab bar is the one whose DOM actually has tabs.
      let tabs = null;
      try {
        tabs = await attach(t.id, ({ evalIn }) => evalIn(`
          Array.prototype.map.call(document.querySelectorAll('${TAB_SELECTOR}'), function(e) {
            return { title: (e.textContent || '').trim().slice(0, 60), active: e.classList.contains('active') };
          })
        `));
      } catch { /* not reachable — treat as not a tab-bar shell */ }
      if (Array.isArray(tabs) && tabs.length) {
        windows.push({ shell_target_id: t.id, tab_count: tabs.length, tabs });
      }
      continue;
    }

    if (kind === 'other') continue;

    let visibility = null;
    try {
      visibility = await attach(t.id, ({ evalIn }) => evalIn('document.visibilityState'));
    } catch { /* target went away mid-listing */ }

    pages.push({
      target_id: t.id,
      kind,
      visible: visibility === 'visible',
      chart_id: chartIdOf(t.url),
      title: (t.title || '').replace(/^Live stock.*charts on /, '').slice(0, 60),
    });
  }

  return {
    success: windows.length > 0,
    window_count: windows.length,
    windows,
    pages,
    note: 'Pin other tools to one of these pages with TV_TARGET_ID=<target_id>. A `visible` page is the tab its window currently shows.',
  };
}

/**
 * Open a second TradingView window by clicking the shell's own
 * "Open new window" button.
 *
 * Two things about that button. Its label is localized, so it is matched
 * through the app's locale bundle (the same table tab_new / layout_new use)
 * with a structural fallback: within the shell's `.action-button`s it is the
 * one that is not `.main-menu-button`. And it is bound to onMouseUp, not
 * onClick — `element.click()` returns cleanly and does nothing at all, so the
 * click has to go through Input.dispatchMouseEvent as a real press/release.
 *
 * The new window comes up on the layout picker, so it does not touch the
 * user's layout by itself. Follow with tab_new / layout_new (pinned to the
 * returned target) to put a chart in it.
 */
export async function open({ wait_ms, _deps } = {}) {
  const { fetchTargets: getTargets, withPage: attach, sleep: wait } = resolve(_deps);
  const budget = Number(wait_ms) > 0 ? Number(wait_ms) : OPEN_WAIT_MS;

  const before = await pageTargets(getTargets);
  const beforeIds = new Set(before.map((t) => t.id));
  // The chart page an unpinned call would have reached before this window
  // existed — i.e. the one the user is looking at. Opening a second window
  // makes the unpinned default ambiguous (verified: the new window can sort
  // first in /json/list and win), so hand this back for pinning reads at the
  // original window and for restoring the default afterwards.
  const previousChart = before.find((t) => kindOf(t.url) === 'chart') || null;
  const shells = before.filter((t) => kindOf(t.url) === 'shell');
  if (!shells.length) {
    throw new Error('TradingView shell window not found. Is this TradingView Desktop with tabs?');
  }

  let clicked = null;
  let lastError = null;
  for (const shell of shells) {
    try {
      clicked = await attach(shell.id, async ({ evalIn, client }) => {
        const hasTabs = await evalIn(`!!document.querySelector('${TAB_SELECTOR}')`);
        if (!hasTabs) return null;

        const language = await evalIn('navigator.language');
        const labels = labelsFor('Open new window', language);
        const box = await evalIn(`
          (function() {
            var wanted = ${JSON.stringify(labels)};
            var buttons = Array.prototype.slice.call(document.querySelectorAll('.action-button'))
              .filter(function(e) { return !e.classList.contains('main-menu-button'); });
            if (!buttons.length) return null;
            var pick = buttons.filter(function(e) { return wanted.indexOf(e.getAttribute('title')) !== -1; })[0]
              || buttons[0];
            var r = pick.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) return null;
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: pick.getAttribute('title') };
          })()
        `);
        if (!box) return null;

        // Real press/release: this button listens on mouseup.
        const at = { x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1 };
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...at, buttons: 0 });
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', ...at, buttons: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', ...at, buttons: 0 });
        return { shell_target_id: shell.id, button_title: box.title };
      });
      if (clicked) break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!clicked) {
    throw new Error(`"Open new window" button not found in the shell window${lastError ? `: ${lastError.message}` : '.'}`);
  }

  const deadline = Date.now() + budget;
  let fresh = [];
  while (Date.now() < deadline) {
    await wait(POLL_MS);
    const now = await pageTargets(getTargets);
    fresh = now.filter((t) => !beforeIds.has(t.id) && kindOf(t.url) !== 'other');
    if (fresh.length) break;
  }

  if (!fresh.length) {
    throw new Error('Clicked "Open new window" but no new window target appeared. Is the app blocking extra windows?');
  }

  const newShell = fresh.find((t) => kindOf(t.url) === 'shell') || null;
  const newPage = fresh.find((t) => kindOf(t.url) === 'landing')
    || fresh.find((t) => kindOf(t.url) === 'chart')
    || null;

  return {
    success: true,
    action: 'window_opened',
    clicked_in_shell: clicked.shell_target_id,
    button_title: clicked.button_title,
    new_shell_target_id: newShell?.id || null,
    target_id: newPage?.id || null,
    target_kind: newPage ? kindOf(newPage.url) : null,
    previous_target_id: previousChart?.id || null,
    new_targets: fresh.map((t) => ({ target_id: t.id, kind: kindOf(t.url) })),
    note: newPage && kindOf(newPage.url) === 'landing'
      ? 'New window is on the layout picker. Give it its own layout with TV_TARGET_ID=<target_id> layout_new — that call returns a NEW target_id (the picker navigates to a chart), which is the one to pin from then on. previous_target_id is the user\'s chart page; pin reads to it when you need the original window. With two windows open, ALWAYS pass TV_TARGET_ID: the unpinned default is ambiguous.'
      : 'Use TV_TARGET_ID=<target_id> to pin other tools to this window. previous_target_id is the chart page an unpinned call reached before this window existed.',
  };
}

/**
 * Close one window by the target id of any page in it (shell or chart page).
 *
 * Refuses to close the last remaining window — that would leave nothing to
 * attach to, and TradingView is the user's live app, not a disposable one.
 */
export async function close({ target_id, _deps } = {}) {
  const { fetchTargets: getTargets, closeTarget, sleep: wait } = resolve(_deps);
  if (!target_id) throw new Error('target_id is required. Run window_list to see the open windows.');

  const before = await pageTargets(getTargets);
  const victim = before.find((t) => t.id === target_id);
  if (!victim) {
    throw new Error(`Target ${target_id} not found. Run window_list — it may already be closed.`);
  }
  const kind = kindOf(victim.url);
  if (kind === 'other') {
    throw new Error(`Target ${target_id} is not a TradingView window or chart page (url: ${victim.url}).`);
  }

  const windowsBefore = before.filter((t) => kindOf(t.url) === 'shell').length;
  if (kind === 'shell' && windowsBefore <= 1) {
    throw new Error('Refusing to close the last TradingView window.');
  }

  await closeTarget(target_id);
  await wait(POLL_MS * 2);

  const after = await pageTargets(getTargets);
  const gone = !after.some((t) => t.id === target_id);

  return {
    success: gone,
    action: gone ? 'closed' : 'close_requested',
    target_id,
    kind,
    windows_before: windowsBefore,
    windows_after: after.filter((t) => kindOf(t.url) === 'shell').length,
    ...(gone ? {} : { error: 'Target still present after close. It may need a moment, or the page blocked unload.' }),
  };
}
