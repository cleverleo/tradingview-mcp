/**
 * Tests for src/core/pine.js compile / smartCompile — finding the Pine editor's
 * "Add to chart" button without ever landing on "Save script".
 *
 * The stub headers mirror what TradingView Desktop 3.4.1 renders: the apply
 * button carries no text, only a `title`, and sits between the script name and
 * the Save button. On a zh-CN UI that title is "添加到图表" before the script is
 * on the chart and "图表更新" after. The old English-text matcher missed it
 * there and clicked Save instead, which opens the "save script" dialog.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findApplyButton, compile, smartCompile } from '../src/core/pine.js';

/** Minimal DOM element: only what findApplyButton touches. */
function el(tagName, { title = null, aria = null, text = '', className = '', hidden = false } = {}) {
  const node = {
    tagName,
    className,
    textContent: text,
    offsetParent: hidden ? null : {},
    parentElement: null,
    children: [],
    clicks: 0,
    getAttribute(name) { return name === 'title' ? title : name === 'aria-label' ? aria : null; },
    click() { node.clicks++; },
  };
  return node;
}

function container(...children) {
  const parent = el('DIV');
  parent.children = children;
  for (const c of children) c.parentElement = parent;
  return parent;
}

/** A document whose querySelectorAll('button') walks the given containers. */
function doc(...containers) {
  const all = [];
  const walk = n => { if (n.tagName === 'BUTTON') all.push(n); n.children.forEach(walk); };
  containers.forEach(walk);
  return { querySelectorAll: sel => { assert.equal(sel, 'button'); return all; } };
}

function editorHeader({ applyTitle, saveTitle = 'Save script', applyText = '' }) {
  const name = el('DIV', { className: 'nameButton-YoyW4Og1' });
  const apply = el('BUTTON', { title: applyTitle, text: applyText, className: 'apply-common-tooltip lightButton-kjRfTlfx noContent-kjRfTlfx' });
  const save = el('BUTTON', { title: saveTitle, className: 'saveButton-lN2I26jn unsaved-lN2I26jn apply-common-tooltip' });
  return { header: container(name, apply, save), apply, save };
}

describe('findApplyButton — editor header', () => {
  for (const [label, title] of [['zh-CN before adding', '添加到图表'], ['zh-CN after adding', '图表更新'], ['English', 'Add to chart']]) {
    it(`picks the button beside Save (${label})`, () => {
      const { header, apply } = editorHeader({ applyTitle: title, saveTitle: '保存脚本' });
      const hit = findApplyButton(doc(header));
      assert.equal(hit.button, apply);
      assert.equal(hit.label, title);
      assert.equal(hit.locator, 'editor_header');
    });
  }

  it('uses the English label to choose when the header grows another button', () => {
    const apply = el('BUTTON', { title: 'Update on chart' });
    const other = el('BUTTON', { title: 'Publish script' });
    const save = el('BUTTON', { className: 'saveButton-x' });
    const hit = findApplyButton(doc(container(other, apply, save)));
    assert.equal(hit.button, apply);
  });

  it('ignores hidden siblings', () => {
    const apply = el('BUTTON', { title: '添加到图表' });
    const ghost = el('BUTTON', { title: 'ghost', hidden: true });
    const save = el('BUTTON', { className: 'saveButton-x' });
    assert.equal(findApplyButton(doc(container(ghost, apply, save))).button, apply);
  });
});

describe('findApplyButton — never the Save button', () => {
  it('returns null when Save is the only button in the header', () => {
    const save = el('BUTTON', { title: '保存脚本', className: 'saveButton-lN2I26jn' });
    assert.equal(findApplyButton(doc(container(el('DIV'), save))), null);
  });

  it('returns null when the header is ambiguous and nothing is labelled', () => {
    const save = el('BUTTON', { className: 'saveButton-x' });
    const a = el('BUTTON', { title: '甲' });
    const b = el('BUTTON', { title: '乙' });
    assert.equal(findApplyButton(doc(container(a, b, save))), null);
  });

  it('does not match "Save and add to chart" — that would save the script', () => {
    const btn = el('BUTTON', { text: 'Save and add to chart' });
    assert.equal(findApplyButton(doc(container(btn))), null);
  });

  it('does not treat a Save button labelled "Add to chart" as the apply button', () => {
    const save = el('BUTTON', { title: 'Add to chart', className: 'saveButton-x' });
    assert.equal(findApplyButton(doc(container(save))), null);
  });
});

describe('findApplyButton — English fallback without the header anchor', () => {
  it('matches text, title or aria-label', () => {
    for (const attrs of [{ text: 'Add to chart' }, { title: 'Update on chart' }, { aria: 'Add to chart' }]) {
      const btn = el('BUTTON', attrs);
      const hit = findApplyButton(doc(container(btn)));
      assert.equal(hit.button, btn, JSON.stringify(attrs));
      assert.equal(hit.locator, 'english_label');
    }
  });

  it('returns null on a localized UI with no header anchor', () => {
    assert.equal(findApplyButton(doc(container(el('BUTTON', { title: '添加到图表' })))), null);
  });
});

describe('the injected script', () => {
  it('runs findApplyButton in the page and clicks what it found', async () => {
    const { header, apply, save } = editorHeader({ applyTitle: '添加到图表', saveTitle: '保存脚本' });
    const page = doc(header);
    let script;
    await compile({
      _deps: {
        ensurePineEditorOpen: async () => true,
        sleep: async () => {},
        evaluate: async (expr) => { script = expr; return new Function('document', `return (${expr});`)(page); },
      },
    });
    assert.match(script, /findApplyButton/);
    assert.equal(apply.clicks, 1);
    assert.equal(save.clicks, 0);
  });
});

/** evaluate stand-in that answers each of smartCompile's page scripts. */
function mockPage({ clicked, studies = [1, 2], markers = [] }) {
  const calls = [];
  let studyCall = 0;
  const evaluate = async (expr) => {
    calls.push(expr);
    if (expr.includes('findApplyButton')) return clicked;
    if (expr.includes('getAllStudies')) return studies[studyCall++];
    if (expr.includes('getModelMarkers')) return markers;
    throw new Error('unexpected script');
  };
  return { calls, _deps: { evaluate, ensurePineEditorOpen: async () => true, sleep: async () => {} } };
}

describe('compile / smartCompile — results', () => {
  it('compile reports the localized label and how it was found', async () => {
    const { _deps } = mockPage({ clicked: { label: '添加到图表', locator: 'editor_header' } });
    const res = await compile({ _deps });
    assert.equal(res.success, true);
    assert.equal(res.button_clicked, '添加到图表');
    assert.equal(res.button_locator, 'editor_header');
  });

  it('compile throws instead of falling back when no button is found', async () => {
    const { _deps } = mockPage({ clicked: null });
    await assert.rejects(compile({ _deps }), /nothing was clicked[\s\S]*Save button/);
  });

  it('smartCompile reports the study it added', async () => {
    const { _deps } = mockPage({ clicked: { label: '添加到图表', locator: 'editor_header' }, studies: [1, 2] });
    const res = await smartCompile({ _deps });
    assert.equal(res.button_clicked, '添加到图表');
    assert.equal(res.study_added, true);
    assert.equal(res.has_errors, false);
  });

  it('smartCompile throws before reading errors when no button is found', async () => {
    const { calls, _deps } = mockPage({ clicked: null });
    await assert.rejects(smartCompile({ _deps }), /nothing was clicked/);
    assert.ok(!calls.some(c => c.includes('getModelMarkers')), 'must stop at the missing button');
  });

  it('refuses to run when the editor does not open', async () => {
    const { calls, _deps } = mockPage({ clicked: null });
    _deps.ensurePineEditorOpen = async () => false;
    await assert.rejects(smartCompile({ _deps }), /Could not open Pine Editor/);
    assert.equal(calls.length, 0);
  });
});
