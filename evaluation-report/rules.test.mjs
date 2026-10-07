import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('./src/rules.js', import.meta.url), 'utf8');

test('补查在唯一一次对比之前，待核单列，可选核验不改原判', t => {
  const dom = new JSDOM('<main id="rules"></main>', { runScripts: 'outside-only' });
  const { window } = dom;
  const frames = [];
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  window.cancelAnimationFrame = () => {};
  window.eval(source);
  const container = window.document.getElementById('rules');
  const controller = window.ReportRules.render(container, { limits: { reviewRounds: 1 } });
  t.after(() => { controller.destroy(); window.close(); });
  const node = id => container.querySelector(`[data-rule-node="${id}"]`);
  assert.equal(node('evidence').textContent, '归因比较点已对齐？');
  assert.equal(node('review').textContent, '对比前补查归因按需 · ≤1 轮');
  assert.match(node('core').textContent, /匿名比较一次/);
  assert.equal(node('unresolved').textContent, '待核不计对战结果');
  assert.doesNotMatch(container.textContent, /再次比较|仍未决/);
  assert.match(container.querySelector('.rules-audit').textContent, /正式结果后显式执行/);
  assert.match(container.querySelector('.rules-audit').textContent, /不改原判、不重做归因/);

  // Geometry isolates the changed edges: review returns to the only comparison,
  // while an unresolved result branches from comparison, not from review.
  const boxes = {
    evidence: [200, 0, 380, 72], review: [820, 0, 180, 72], core: [200, 150, 380, 62], unresolved: [820, 150, 180, 62],
    single: [0, 300, 200, 78], neither: [260, 300, 200, 78], difference: [600, 300, 400, 78],
    'core-win': [0, 450, 200, 76], 'both-bad': [260, 450, 200, 76], 'quality-win': [600, 450, 160, 76], 'both-good': [840, 450, 160, 76],
  };
  const rectangle = ([left, top, width, height]) => ({ left, top, width, height, right: left + width, bottom: top + height });
  container.querySelector('.rules-tree').getBoundingClientRect = () => rectangle([0, 0, 1000, 526]);
  for (const [id, box] of Object.entries(boxes)) node(id).getBoundingClientRect = () => rectangle(box);
  frames.shift()();
  const paths = [...container.querySelectorAll('.rules-edge')].map(path => path.getAttribute('d'));
  assert.ok(paths.includes('M580 181H817'), '待核须从唯一比较节点分出');
  assert.ok(paths.some(path => path.startsWith('M863.2 72') && path.endsWith('V147')), '归因补查须汇入首次比较');
  assert.ok(!paths.includes('M910 72V147'), '不能把归因补查画成比较后复核');

  for (const button of container.querySelectorAll('[data-rule-result]')) {
    button.click();
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.ok(node('core').classList.contains('on-rule-path'));
    container.querySelector('.rules-tree').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(container.querySelectorAll('[aria-pressed="true"]').length, 0);
  }
});
