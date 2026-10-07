import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const scripts = await Promise.all(['prompt-data', 'prompts'].map(name =>
  readFile(new URL(`./src/${name}.js`, import.meta.url), 'utf8')));
const groups = ['criteria', 'attribution', 'comparison', 'clustering', 'rewrite', 'shared', 'tools'];

function reader(t) {
  const dom = new JSDOM('<main><div id="reader"></div><div id="other"></div></main>', { runScripts: 'outside-only' });
  scripts.forEach(source => dom.window.eval(source));
  const api = dom.window.ReportPrompts;
  const container = dom.window.document.getElementById('reader');
  const controller = api.render(container);
  t.after(() => { controller.destroy(); dom.window.close(); });
  return { window: dom.window, api, container, controller };
}

test('当前提示词快照覆盖五角色、可选核验、共用文案与工具，独立于案例评测器', t => {
  const { window, api } = reader(t);
  assert.equal(window.ReportPromptData.evaluatorVersion, 'r153');
  assert.equal(api.evaluatorVersion, 'r153');
  assert.equal(api.data.length, 34);
  assert.equal(new Set(api.data.map(resource => resource.id)).size, 34);
  assert.equal(new Set(api.data.map(resource => resource.path)).size, 34);
  assert.deepEqual([...new Set(api.data.map(resource => resource.group))], groups);
  for (const resource of api.data) {
    const parts = resource.id.split('/');
    const directory = groups.slice(0, 5).includes(resource.group)
      ? `${resource.group}/${parts.length === 3 ? parts[1] : 'default'}` : resource.group;
    assert.equal(parts[0], resource.group);
    assert.equal(resource.path, `packages/prompts/resources/${directory}/${parts.at(-1)}.md`);
    assert.ok(resource.text.trim() && resource.name.trim());
  }
  const text = id => api.data.find(resource => resource.id === id).text;
  assert.match(text('criteria/instructions'), /source_indices 和 text/);
  assert.match(text('attribution/instructions'), /保留全部具体发现，不凑固定条数/);
  assert.match(text('comparison/instructions'), /按 comparison_slots 的数量和顺序/);
  assert.match(text('rewrite/instructions'), /texts 字符串数组/);
  assert.match(text('clustering/instructions'), /class_updates/);
  for (const id of ['comparison/verification/system', 'comparison/verification/instructions', 'shared/evidence', 'shared/task-focus', 'tools/inspect_material']) assert.ok(text(id));
});

test('七入口直接显示34份完整原文；关键规则、执行结构与职责边界同时呈现', t => {
  const { api, container, controller } = reader(t);
  assert.deepEqual([...container.querySelectorAll('[data-prompt-component]')].map(node => node.textContent),
    ['验收标准', '独立归因', '匿名比较', '问题归类', '评语润色', '共用材料', '工具说明']);
  const visited = new Set();
  for (const group of groups) {
    controller.select(group);
    assert.equal(container.querySelector('.rp-snapshot'), null);
    if (groups.slice(0, 5).includes(group)) {
      assert.deepEqual([...container.querySelectorAll('.rp-workflow dt')].map(node => node.textContent), ['输入', '执行', '产出']);
      assert.ok(container.querySelector('.rp-responsibility p').textContent.trim());
      const excerpts = [...container.querySelectorAll('[data-prompt-excerpt]')];
      assert.equal(excerpts.length, 3);
      for (const excerpt of excerpts) assert.ok(api.data.find(resource => resource.id === excerpt.dataset.promptExcerpt).text.includes(excerpt.textContent));
      assert.ok(container.querySelector(`[data-prompt-original="${group}/instructions"] .rp-rule-block`));
    }
    for (const original of container.querySelectorAll('[data-prompt-original]')) {
      assert.equal(original.textContent, api.data.find(resource => resource.id === original.dataset.promptOriginal).text);
      assert.equal(original.closest('details,[hidden]'), null);
      visited.add(original.dataset.promptOriginal);
    }
  }
  assert.equal(visited.size, 34);
  assert.equal(container.querySelector('details,[download],textarea'), null);
  controller.select('attribution');
  assert.ok(container.querySelector('[data-prompt-original="tools/submit_evaluation"]'));
  assert.equal(container.querySelector('[data-prompt-original="tools/submit_evaluation_file"]'), null);
  controller.select('comparison');
  assert.ok(container.querySelector('[data-prompt-original="tools/submit_evaluation_file"]'));
  assert.equal(container.querySelector('[data-prompt-original="tools/submit_evaluation"]'), null);
  assert.equal(container.querySelectorAll('[data-prompt-original^="comparison/verification/"]').length, 2);
  assert.match(container.querySelector('.rp-verification-boundary').textContent, /不改原判、不重开归因/);
});

test('提示词键盘选择、重复挂载与销毁保持焦点和监听边界', t => {
  const { window, api, container, controller } = reader(t);
  const original = container.querySelector('[data-prompt-component="criteria"]');
  original.focus();
  original.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(controller.selected, 'attribution');
  assert.equal(window.document.activeElement.dataset.promptComponent, 'attribution');
  const stale = container.querySelector('[data-prompt-component="comparison"]');
  const next = api.render(container);
  t.after(() => next.destroy());
  stale.click();
  assert.equal(controller.selected, 'attribution');
  assert.equal(next.selected, 'criteria');
  const selected = container.querySelector('[aria-selected="true"]');
  selected.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  assert.equal(next.selected, 'tools');
  assert.equal(window.document.activeElement.dataset.promptComponent, 'tools');
  next.destroy();
  container.querySelector('[data-prompt-component="rewrite"]').click();
  assert.equal(next.selected, 'tools');
});
