/**
 * Tests for batchRun in src/core/batch.js.
 *
 * Two defects motivated these: `get_ohlcv` went through
 * `chartApi.exportData()`, which rejects — every iteration failed with
 * "JS evaluation error: Uncaught (in promise)" — and an action that produced
 * an `{ error }` result was still pushed as `success: true`, so a batch in
 * which nothing worked reported `successful: N, failed: 0`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { batchRun } from '../src/core/batch.js';

/** Deps for a chart that switches symbols happily; actions are per-test. */
function mockDeps(overrides = {}) {
  const calls = { setSymbol: [], setResolution: [], ohlcv: [] };
  return {
    calls,
    deps: {
      getChartCollection: async () => 'COL',
      getChartApi: async () => 'API',
      waitForChartReady: async () => true,
      getClient: async () => { throw new Error('screenshot is not exercised here'); },
      evaluate: async (expr) => {
        const sym = expr.match(/setSymbol\("(.+?)"\)/);
        if (sym) { calls.setSymbol.push(sym[1]); return undefined; }
        const res = expr.match(/setResolution\("(.+?)"\)/);
        if (res) { calls.setResolution.push(res[1]); return undefined; }
        return overrides.evaluateResult ?? undefined;
      },
      getOhlcv: async (args) => {
        calls.ohlcv.push(args);
        if (overrides.ohlcvThrows) throw new Error(overrides.ohlcvThrows);
        return {
          success: true, bar_count: 100,
          period: { from: 1, to: 2 }, open: 10, close: 12, high: 13, low: 9,
          range: 4, change: 2, change_pct: '20%', avg_volume: 1000,
          last_5_bars: [{ time: 2, open: 11, high: 13, low: 9, close: 12, volume: 5 }],
        };
      },
      ...(overrides.deps || {}),
    },
  };
}

const run = (args, deps) => batchRun({ delay_ms: 0, _deps: deps, ...args });

describe('batchRun — action validation', () => {
  it('rejects an unknown action before touching the chart', async () => {
    const { deps, calls } = mockDeps();
    await assert.rejects(
      () => run({ symbols: ['AAPL', 'MSFT'], action: 'quote_get' }, deps),
      /Unknown action: quote_get.*screenshot, get_ohlcv, get_strategy_results/,
    );
    assert.deepEqual(calls.setSymbol, [], 'the user\'s chart must not be touched for an invalid action');
  });

  it('accepts each documented action name', async () => {
    for (const action of ['get_ohlcv', 'get_strategy_results']) {
      const { deps } = mockDeps({ evaluateResult: { metric_count: 0, metrics: {} } });
      const r = await run({ symbols: ['AAPL'], action }, deps);
      assert.equal(r.total_iterations, 1, `${action} should have run`);
    }
  });
});

describe('batchRun — get_ohlcv', () => {
  it('reads bars through getOhlcv rather than exportData', async () => {
    const { deps, calls } = mockDeps();
    const r = await run({ symbols: ['AAPL', 'MSFT'], action: 'get_ohlcv', ohlcv_count: 50 }, deps);

    assert.equal(r.success, true);
    assert.equal(r.successful, 2);
    assert.equal(r.failed, 0);
    assert.deepEqual(calls.setSymbol, ['AAPL', 'MSFT']);
    assert.deepEqual(calls.ohlcv, [{ count: 50, summary: true }, { count: 50, summary: true }]);
    assert.equal(r.results[0].result.close, 12);
  });

  it('drops last_5_bars and the redundant success flag from each result', async () => {
    const { deps } = mockDeps();
    const r = await run({ symbols: ['AAPL'], action: 'get_ohlcv' }, deps);
    const keys = Object.keys(r.results[0].result);
    assert.ok(!keys.includes('last_5_bars'), 'per-symbol bars would multiply the payload');
    assert.ok(!keys.includes('success'), 'the iteration already carries its own success flag');
    assert.ok(keys.includes('bar_count') && keys.includes('change_pct'));
  });

  it('records a thrown read as that iteration failing, and keeps going', async () => {
    const { deps } = mockDeps({ ohlcvThrows: 'Could not extract OHLCV data.' });
    const r = await run({ symbols: ['AAPL', 'MSFT'], action: 'get_ohlcv' }, deps);

    assert.equal(r.success, false);
    assert.equal(r.successful, 0);
    assert.equal(r.failed, 2);
    assert.match(r.results[0].error, /Could not extract OHLCV/);
  });
});

describe('batchRun — success accounting', () => {
  it('counts an action that returned { error } as a failure', async () => {
    const { deps } = mockDeps({ evaluateResult: { error: 'Strategy Tester not found' } });
    const r = await run({ symbols: ['AAPL', 'MSFT'], action: 'get_strategy_results' }, deps);

    assert.equal(r.successful, 0, 'an { error } result is not a success');
    assert.equal(r.failed, 2);
    assert.equal(r.success, false, 'top-level success must not stay true when every iteration failed');
    for (const one of r.results) {
      assert.equal(one.success, false);
      assert.equal(one.error, 'Strategy Tester not found');
    }
  });

  it('reports success false on a partial failure, with the good results intact', async () => {
    let n = 0;
    const { deps } = mockDeps({
      deps: {
        getOhlcv: async () => {
          if (n++ === 0) return { success: true, bar_count: 10, close: 1, last_5_bars: [] };
          throw new Error('no data for this symbol');
        },
      },
    });
    const r = await run({ symbols: ['AAPL', 'MSFT'], action: 'get_ohlcv' }, deps);

    assert.equal(r.success, false);
    assert.equal(r.successful, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.results[0].result.bar_count, 10);
    assert.match(r.results[1].error, /no data/);
  });

  it('honours delay_ms: 0 instead of falling back to the 2s default', async () => {
    const { deps } = mockDeps();
    const t0 = Date.now();
    await batchRun({ symbols: ['A', 'B', 'C'], action: 'get_ohlcv', delay_ms: 0, _deps: deps });
    assert.ok(Date.now() - t0 < 1000, 'three iterations at the default delay would take ~6s');
  });

  it('iterates every symbol × timeframe combination', async () => {
    const { deps, calls } = mockDeps();
    const r = await run({ symbols: ['AAPL', 'MSFT'], timeframes: ['60', 'D'], action: 'get_ohlcv' }, deps);

    assert.equal(r.total_iterations, 4);
    assert.equal(r.successful, 4);
    assert.deepEqual(calls.setResolution, ['60', 'D', '60', 'D']);
  });
});
