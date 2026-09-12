/**
 * Tests for src/core/ui.js layoutDelete — the guards around a delete that
 * cannot be undone. The id/name cross-check and the "currently open layout"
 * refusal run inside the page, so what is covered here is the argument
 * validation and how a refusal coming back from the page is surfaced.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layoutDelete } from '../src/core/ui.js';

/** evaluateAsync stand-in: returns a scripted result and records the script. */
function mockEval(result) {
  const calls = [];
  const fn = async (expr) => { calls.push(expr); return result; };
  fn.calls = calls;
  return fn;
}

describe('layoutDelete — argument guards', () => {
  it('requires layout_id', async () => {
    const evaluateAsync = mockEval({});
    await assert.rejects(layoutDelete({ name: 'scratch', _deps: { evaluateAsync } }), /layout_id is required/);
    assert.equal(evaluateAsync.calls.length, 0, 'must not reach the page');
  });

  it('requires layout_id to be non-blank', async () => {
    const evaluateAsync = mockEval({});
    await assert.rejects(layoutDelete({ layout_id: '   ', name: 'scratch', _deps: { evaluateAsync } }), /layout_id is required/);
    assert.equal(evaluateAsync.calls.length, 0);
  });

  it('requires name as a cross-check', async () => {
    const evaluateAsync = mockEval({});
    await assert.rejects(layoutDelete({ layout_id: 204048170, _deps: { evaluateAsync } }), /name is required as a cross-check/);
    assert.equal(evaluateAsync.calls.length, 0, 'an id alone must never reach the page');
  });

  it('requires name to be non-blank', async () => {
    const evaluateAsync = mockEval({});
    await assert.rejects(layoutDelete({ layout_id: 1, name: '  ', _deps: { evaluateAsync } }), /name is required/);
    assert.equal(evaluateAsync.calls.length, 0);
  });

  it('passes both id and name into the page script', async () => {
    const evaluateAsync = mockEval({ deleted: { id: 7, name: 'scratch', chart_id: 'aB3' }, gone: true, layouts_before: 2, layouts_after: 1 });
    await layoutDelete({ layout_id: 7, name: 'scratch', _deps: { evaluateAsync } });
    const script = evaluateAsync.calls[0];
    assert.match(script, /var wantId = "7"/);
    assert.match(script, /var wantName = "scratch"/);
    assert.match(script, /removeChartFromServer/);
  });

  it('accepts the short chart_id as well as the numeric id', async () => {
    const evaluateAsync = mockEval({ deleted: { id: 7, name: 'scratch', chart_id: 'pFr8oRVr' }, gone: true, layouts_before: 2, layouts_after: 1 });
    const res = await layoutDelete({ layout_id: 'pFr8oRVr', name: 'scratch', _deps: { evaluateAsync } });
    assert.equal(res.success, true);
    assert.match(evaluateAsync.calls[0], /var wantId = "pFr8oRVr"/);
  });

  it('deletes by the short id, not the numeric one — the endpoint rejects numbers', async () => {
    const evaluateAsync = mockEval({ deleted: { id: 7, name: 'x', chart_id: 'aB3' }, gone: true });
    await layoutDelete({ layout_id: 7, name: 'x', _deps: { evaluateAsync } });
    const script = evaluateAsync.calls[0];
    // uid comes from match.url (the short id); passing match.id would come
    // back 400 invalid_data {"uid.0":["Expected string."]}.
    assert.match(script, /var uid = match\.url/);
    assert.match(script, /removeChartFromServer\(uid\)/);
  });
});

describe('layoutDelete — results', () => {
  it('reports a successful delete', async () => {
    const evaluateAsync = mockEval({ deleted: { id: 204048170, name: 'claude-scratch', chart_id: 'XpARaAUx' }, gone: true, layouts_before: 2, layouts_after: 1 });
    const res = await layoutDelete({ layout_id: 204048170, name: 'claude-scratch', _deps: { evaluateAsync } });
    assert.equal(res.success, true);
    assert.equal(res.action, 'layout_deleted');
    assert.deepEqual(res.deleted, { id: 204048170, name: 'claude-scratch', chart_id: 'XpARaAUx' });
    assert.equal(res.verified, true);
    assert.equal(res.layouts_before, 2);
    assert.equal(res.layouts_after, 1);
    assert.equal(res.error, undefined);
  });

  it('marks an unconfirmed delete as successful but unverified', async () => {
    const evaluateAsync = mockEval({ deleted: { id: 1, name: 'x', chart_id: 'aB3' }, gone: null, layouts_before: 2 });
    const res = await layoutDelete({ layout_id: 1, name: 'x', _deps: { evaluateAsync } });
    assert.equal(res.success, true);
    assert.equal(res.verified, false);
    assert.match(res.note, /run layout_list to confirm/);
    assert.equal(res.error, undefined);
  });

  it('surfaces the backend HTTP rejection', async () => {
    const evaluateAsync = mockEval({ error: 'TradingView rejected the delete (HTTP 400): {"code":"invalid_data","errors":{"uid.0":["Expected string."]}}' });
    await assert.rejects(
      layoutDelete({ layout_id: 7, name: 'x', _deps: { evaluateAsync } }),
      /rejected the delete \(HTTP 400\)/,
    );
  });

  it('flags a delete that was accepted but did not take', async () => {
    const evaluateAsync = mockEval({ deleted: { id: 1, name: 'x' }, gone: false, layouts_before: 2, layouts_after: 2 });
    const res = await layoutDelete({ layout_id: 1, name: 'x', _deps: { evaluateAsync } });
    assert.equal(res.success, false);
    assert.match(res.error, /still listed/);
  });

  it('surfaces the name-mismatch refusal from the page', async () => {
    const evaluateAsync = mockEval({ error: 'Refusing to delete: id 5 is "个股", but name was given as "scratch". Re-read layout_list.' });
    await assert.rejects(layoutDelete({ layout_id: 5, name: 'scratch', _deps: { evaluateAsync } }), /Refusing to delete/);
  });

  it('surfaces the open-layout refusal', async () => {
    const evaluateAsync = mockEval({ error: 'Layout "个股" is the one open in this window. Switch away first (layout_switch), or delete it from another window.' });
    await assert.rejects(layoutDelete({ layout_id: 5, name: '个股', _deps: { evaluateAsync } }), /open in this window/);
  });

  it('appends the available layouts when the id is unknown', async () => {
    const evaluateAsync = mockEval({ error: 'No layout with id 999.', available: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    await assert.rejects(
      layoutDelete({ layout_id: 999, name: 'whatever', _deps: { evaluateAsync } }),
      /No layout with id 999\. Available: 1 \(a\), 2 \(b\)/,
    );
  });
});
