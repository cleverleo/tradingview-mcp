import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/window.js';

export function registerWindowTools(server) {
  server.tool('window_list', 'List the open TradingView windows and the chart / layout-picker pages behind them, with the target ids to pin TV_TARGET_ID to', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('window_open', 'Open a second TradingView window (lands on the layout picker) so UI side effects stay out of the window the user is watching. Returns the target id to use as TV_TARGET_ID.', {}, async () => {
    try { return jsonResult(await core.open()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('window_close', 'Close a TradingView window by the target id of any page in it. Refuses to close the last window.', {
    target_id: z.string().describe('Target id from window_list (shell_target_id, or a page target_id)'),
  }, async ({ target_id }) => {
    try { return jsonResult(await core.close({ target_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
