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

// Which window a page is in can't be read off /json/list, and CDP's direct
// answer, Browser.getWindowForTarget, isn't implemented by Electron ("wasn't
// found", Desktop 3.4.1). But a window's shell and the page it shows report
// the same outer window geometry — verified with three windows open, each
// chart page matched its own shell on all four numbers (innerHeight differs
// by the tab bar, so it is left out). Unverified: whether a hidden tab still
// reports its window's geometry, which is why callers that click check
// `page_visible` too.
const BOUNDS_EXPR = '({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight })';

function sameBounds(a, b) {
  return !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(a[k]) && a[k] === b[k]);
}

/**
 * The shells that actually carry a tab bar, with their tabs and window bounds.
 * Several targets share the shell URL (tooltip layers, helper views); the real
 * tab bar is the one whose DOM actually has tabs.
 */
async function readTabBars(targets, attach) {
  const shells = [];
  for (const t of targets) {
    if (kindOf(t.url) !== 'shell') continue;
    let state = null;
    try {
      state = await attach(t.id, async ({ evalIn }) => ({
        tabs: await evalIn(`
          Array.prototype.map.call(document.querySelectorAll('${TAB_SELECTOR}'), function(e) {
            return { title: (e.textContent || '').trim().slice(0, 60), active: e.classList.contains('active') };
          })
        `),
        bounds: await evalIn(BOUNDS_EXPR),
      }));
    } catch { /* not reachable — treat as not a tab-bar shell */ }
    if (Array.isArray(state?.tabs) && state.tabs.length) {
      shells.push({ shell_target_id: t.id, tab_count: state.tabs.length, tabs: state.tabs, bounds: state.bounds });
    }
  }
  return shells;
}

/** Visibility and window bounds of one page; nulls if it went away. */
async function readPage(targetId, attach) {
  try {
    return await attach(targetId, async ({ evalIn }) => ({
      visible: (await evalIn('document.visibilityState')) === 'visible',
      bounds: await evalIn(BOUNDS_EXPR),
    }));
  } catch {
    return { visible: false, bounds: null };
  }
}

/** Tab-bar shells, each with its tab count, tabs and window bounds. */
export async function tabBarShells({ _deps } = {}) {
  const { fetchTargets: getTargets, withPage: attach } = resolve(_deps);
  return readTabBars(await pageTargets(getTargets), attach);
}

/**
 * Resolve the window a page lives in: its tab-bar shell, plus whether the
 * page is the tab that window is showing. A shell id resolves to itself.
 *
 * Throws instead of guessing whenever the answer isn't exactly one window.
 * The callers click in the shell this returns, and a wrong guess closes or
 * switches a tab in a window the user is watching.
 */
export async function shellFor(targetId, { _deps } = {}) {
  const { fetchTargets: getTargets, withPage: attach } = resolve(_deps);
  const targets = await pageTargets(getTargets);
  const page = targets.find((t) => t.id === targetId);
  if (!page) {
    throw new Error(`Target ${targetId} not found. Run window_list — it may already be closed.`);
  }
  const kind = kindOf(page.url);
  if (kind === 'other') {
    throw new Error(`Target ${targetId} is not a TradingView window or chart page (url: ${page.url}).`);
  }

  const shells = await readTabBars(targets, attach);

  if (kind === 'shell') {
    const own = shells.find((s) => s.shell_target_id === targetId);
    if (!own) throw new Error(`Target ${targetId} is a shell view without a tab bar. Use a shell_target_id or page target_id from window_list.`);
    return { shell_target_id: own.shell_target_id, tab_count: own.tab_count, page_kind: kind, page_visible: null };
  }

  const state = await readPage(targetId, attach);
  const owners = shells.filter((s) => sameBounds(s.bounds, state.bounds));
  if (owners.length > 1) {
    throw new Error(`Can't tell which window page ${targetId} is in: ${owners.length} windows sit at exactly the same position and size. Move or resize one of them.`);
  }
  if (!owners.length) {
    throw new Error(`Can't tell which window page ${targetId} is in: no tab bar matches its window bounds`
      + (state.visible ? '.' : ' (it is not the tab its window is showing — switch to it, or pin the visible page from window_list).'));
  }
  return { shell_target_id: owners[0].shell_target_id, tab_count: owners[0].tab_count, page_kind: kind, page_visible: state.visible };
}

/**
 * List the open windows and every chart / layout-picker page behind them.
 *
 * A window's own tab bar lives in its shell target, so shells are what get
 * counted as windows. Each page carries the `shell_target_id` of the window
 * it is in (matched by window bounds, see BOUNDS_EXPR; null when that match
 * isn't unique). Each window shows exactly one tab at a time, so the pages
 * marked `visible` are the current tab of some window, and those are the ids
 * worth pinning TV_TARGET_ID to.
 */
export async function list({ _deps } = {}) {
  const { fetchTargets: getTargets, withPage: attach } = resolve(_deps);
  const targets = await pageTargets(getTargets);
  const shells = await readTabBars(targets, attach);

  const pages = [];
  for (const t of targets) {
    const kind = kindOf(t.url);
    if (kind === 'shell' || kind === 'other') continue;

    const state = await readPage(t.id, attach);
    const owners = shells.filter((s) => sameBounds(s.bounds, state.bounds));

    pages.push({
      target_id: t.id,
      kind,
      visible: state.visible,
      shell_target_id: owners.length === 1 ? owners[0].shell_target_id : null,
      chart_id: chartIdOf(t.url),
      title: (t.title || '').replace(/^Live stock.*charts on /, '').slice(0, 60),
    });
  }

  return {
    success: shells.length > 0,
    window_count: shells.length,
    windows: shells.map((s) => ({ shell_target_id: s.shell_target_id, tab_count: s.tab_count, tabs: s.tabs })),
    pages,
    note: 'Pin other tools to one of these pages with TV_TARGET_ID=<target_id>. A `visible` page is the tab its window currently shows; `shell_target_id` is the window it is in. tab_close / tab_switch / tab_new act on the pinned page\'s window.',
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
