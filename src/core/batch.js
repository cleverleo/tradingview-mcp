/**
 * Core batch execution logic.
 */
import { evaluate as _evaluate, getClient as _getClient, getChartApi as _getChartApi, getChartCollection as _getChartCollection, safeString } from '../connection.js';
import { getOhlcv as _getOhlcv } from './data.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

const ACTIONS = ['screenshot', 'get_ohlcv', 'get_strategy_results'];

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getClient: deps?.getClient || _getClient,
    getChartApi: deps?.getChartApi || _getChartApi,
    getChartCollection: deps?.getChartCollection || _getChartCollection,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
    getOhlcv: deps?.getOhlcv || _getOhlcv,
  };
}

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count, _deps }) {
  const { evaluate, getClient, getChartApi, getChartCollection, waitForChartReady, getOhlcv } = _resolve(_deps);

  // Validate before touching the chart: an unrecognised action used to switch
  // the symbol once per iteration and only then report the problem.
  if (!ACTIONS.includes(action)) {
    throw new Error(`Unknown action: ${action}. Expected one of: ${ACTIONS.join(', ')}`);
  }

  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  const delay = delay_ms ?? 2000; // `||` here made delay_ms: 0 unreachable
  const results = [];

  let colPath, apiPath;
  try { colPath = await getChartCollection(); } catch {}
  try { apiPath = await getChartApi(); } catch {}

  for (const symbol of symbols) {
    for (const tf of tfs) {
      const combo = { symbol, timeframe: tf };
      try {
        if (colPath) await evaluate(`${colPath}.setSymbol(${safeString(symbol)})`);
        else if (apiPath) await evaluate(`${apiPath}.setSymbol(${safeString(symbol)})`);

        if (tf) {
          if (colPath) await evaluate(`${colPath}.setResolution(${safeString(tf)})`);
          else if (apiPath) await evaluate(`${apiPath}.setResolution(${safeString(tf)})`);
        }

        await waitForChartReady(symbol);
        await new Promise(r => setTimeout(r, delay));

        let actionResult;
        if (action === 'screenshot') {
          mkdirSync(SCREENSHOT_DIR, { recursive: true });
          const client = await getClient();
          const { data } = await client.Page.captureScreenshot({ format: 'png' });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fname = `batch_${symbol}_${tf || 'default'}_${ts}`.replace(/[\/\\]/g, '_') + '.png';
          const filePath = join(SCREENSHOT_DIR, fname);
          writeFileSync(filePath, Buffer.from(data, 'base64'));
          actionResult = { file_path: filePath };
        } else if (action === 'get_ohlcv') {
          // Read the series bars directly, the way data_get_ohlcv does.
          // chartApi.exportData() rejects here, and the rejection reached the
          // caller only as "JS evaluation error: Uncaught (in promise)".
          const { success, last_5_bars, ...summary } = await getOhlcv({ count: ohlcv_count, summary: true });
          actionResult = summary; // last_5_bars is dropped: one batch would carry N copies of it
        } else if (action === 'get_strategy_results') {
          await new Promise(r => setTimeout(r, 1000));
          actionResult = await evaluate(`
            (function() {
              var metrics = {};
              var panel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
              if (!panel) return { error: 'Strategy Tester not found' };
              var items = panel.querySelectorAll('[class*="reportItem"], [class*="metric"]');
              items.forEach(function(item) {
                var label = item.querySelector('[class*="label"]');
                var value = item.querySelector('[class*="value"]');
                if (label && value) metrics[label.textContent.trim()] = value.textContent.trim();
              });
              return { metric_count: Object.keys(metrics).length, metrics: metrics };
            })()
          `);
        }

        // An action that returns `{ error }` has not succeeded — counting it as
        // one produced `successful: N, failed: 0` alongside N failed results.
        if (actionResult && actionResult.error) results.push({ ...combo, success: false, error: actionResult.error });
        else results.push({ ...combo, success: true, result: actionResult });
      } catch (err) {
        results.push({ ...combo, success: false, error: err.message });
      }
    }
  }

  const successCount = results.filter(r => r.success).length;
  return {
    success: successCount === results.length,
    total_iterations: results.length,
    successful: successCount,
    failed: results.length - successCount,
    results,
  };
}
