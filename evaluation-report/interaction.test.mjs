import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createInterface } from 'node:readline';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildReport } from './build.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const scriptNames = ['data', 'motion', 'icons', 'diagram-interaction', 'flow'];
const [sourceHtml, ...sources] = await Promise.all([
  readFile(join(directory, 'index.html'), 'utf8'),
  ...scriptNames.map(name => readFile(join(directory, `src/${name}.js`), 'utf8')),
]);
const regionIds = [
  'source-materials', 'shared-rubric-and-attribution', 'identity-mapping', 'paired-comparison',
  'formal-outcomes', 'bounded-review', 'problem-clustering', 'text-only-rewrite',
];

function environment(t, html = sourceHtml, inline = false) {
  const errors = [];
  const downloads = [];
  const controllers = new Set();
  const blobs = new Map();
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {
    // JSDOM rejects file: history.replaceState; no resources or network access are enabled here.
    url: 'https://offline-report.invalid/report.html',
    runScripts: inline ? 'dangerously' : 'outside-only',
    virtualConsole: console,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.matchMedia = () => ({ matches: true, addEventListener() {} });
      window.URL.createObjectURL = blob => {
        const url = `blob:report-${blobs.size}`;
        blobs.set(url, blob);
        return url;
      };
      window.URL.revokeObjectURL = url => blobs.delete(url);
      window.HTMLAnchorElement.prototype.click = function () {
        downloads.push({ name: this.download, blob: blobs.get(this.href) });
      };
    },
  });
  t.after(() => {
    try {
      controllers.forEach(controller => controller.destroy());
      assert.deepEqual(errors, [], '页面执行不能产生未捕获错误');
    } finally {
      dom.window.close();
    }
  });
  if (!inline) sources.forEach(source => dom.window.eval(source));
  const document = dom.window.document;
  return {
    window: dom.window, document, controllers, downloads,
    group: id => document.querySelector(`[data-region="${id}"]`),
    trigger: id => document.querySelector(`[data-region="${id}"] .region-hit[role="button"]`),
    mouse(element, type = 'click') {
      element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: type === 'click' }));
    },
    key(element, key) {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    },
    downloadText(index = downloads.length - 1) {
      return new Promise((resolve, reject) => {
        const reader = new dom.window.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(downloads[index].blob);
      });
    },
  };
}

function diagram(t) {
  const page = environment(t);
  const mount = page.window.ReportDiagram.mount;
  let options;
  page.window.ReportDiagram.mount = (root, args) => {
    options = args;
    return mount(root, args);
  };
  const controller = page.window.ReportFlow.render(page.document.getElementById('flowBody'), page.window.EvaluationReportData);
  page.controllers.add(controller);
  page.window.ReportDiagram.mount = mount;
  return { ...page, controller, options, root: page.document.querySelector('.research-figure') };
}

function assertOverview(page) {
  assert.equal(page.document.getElementById('mechanismScene').style.transform, '');
  assert.equal(page.document.querySelector('[data-reset-diagram]').hidden, true);
  assert.equal(page.document.querySelector('.research-figure').classList.contains('is-zoomed'), false);
}

function assertMapping(page, swapped = false) {
  const recorded = page.window.EvaluationReportData.mechanismCase;
  const identities = Array.from(recorded.initialLabels);
  if (swapped) identities.reverse();
  assert.deepEqual({
    packages: [...page.document.querySelectorAll('#identity-mapping .identity-label')].map(node => node.textContent),
    columns: [...page.document.querySelectorAll('#comparison-grid .matrix-header')].slice(1).map(node => node.textContent),
    winner: page.document.getElementById('winnerLabel').textContent,
    sourceWinner: page.document.getElementById('sourceWinner').textContent,
  }, {
    packages: identities, columns: identities,
    winner: `${identities[recorded.winnerIndex]} 胜`, sourceWinner: recorded.candidates[recorded.winnerIndex].source,
  });
}

async function sourceRecord(file, caseId, predicate) {
  const stream = createReadStream(join(directory, '..', file), { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(JSON.stringify(caseId))) continue;
      const record = JSON.parse(line);
      if (predicate(record)) return record;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  assert.fail(`未找到案例来源记录：${file}`);
}

const plain = value => JSON.parse(JSON.stringify(value));
const valueAt = (value, path) => path.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((item, key) => item?.[key], value);

test('真实机制图有八个独立操作矩形，图标和箭头只引用本页对象', t => {
  const page = diagram(t);
  assert.deepEqual([...page.document.querySelectorAll('[data-region]')].map(node => node.dataset.region), regionIds);
  for (const region of page.options.regions) {
    const group = page.group(region.id);
    const trigger = page.trigger(region.id);
    assert.equal(group.hasAttribute('role'), false, '长连线所在 group 不能成为按钮包围盒');
    assert.equal(trigger.tagName.toLowerCase(), 'rect');
    assert.equal(trigger.getAttribute('tabindex'), '0');
    assert.ok(trigger.getAttribute('aria-label'));
    assert.deepEqual(['x', 'y', 'width', 'height'].map(name => Number(trigger.getAttribute(name))), Array.from(region.bounds));
  }
  const ids = [...page.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  const svg = page.document.getElementById('evaluationMechanism');
  for (const use of svg.querySelectorAll('use')) {
    const href = use.getAttribute('href');
    assert.match(href, /^#phosphor-/);
    assert.equal(page.document.getElementById(href.slice(1))?.tagName.toLowerCase(), 'symbol');
  }
  assert.ok(svg.querySelectorAll('use').length > 0);
  for (const path of svg.querySelectorAll('[marker-end]')) {
    const match = path.getAttribute('marker-end').match(/^url\(#([\w-]+)\)$/);
    assert.ok(match);
    assert.equal(page.document.getElementById(match[1])?.tagName.toLowerCase(), 'marker');
  }
});

test('关联高亮、连续缩放和键盘返回围绕实际操作矩形工作', t => {
  const page = diagram(t);
  const scene = page.document.getElementById('mechanismScene');
  const source = page.trigger('source-materials');
  const comparison = page.trigger('paired-comparison');
  page.mouse(page.group('source-materials'), 'mouseenter');
  assert.equal(page.group('source-materials').classList.contains('active'), true);
  assert.equal(page.group('shared-rubric-and-attribution').classList.contains('related'), true);
  assert.equal(page.group('problem-clustering').classList.contains('muted'), true);
  page.mouse(page.group('source-materials'), 'mouseleave');
  assert.equal(page.root.querySelectorAll('.active,.related,.muted').length, 0);

  source.focus();
  page.key(source, 'Enter');
  const firstTransform = scene.style.transform;
  assert.ok(firstTransform);
  const scale = Number(firstTransform.match(/scale\(([\d.]+)\)/)?.[1]);
  assert.ok(scale >= 1 && scale <= 2.5);
  page.mouse(page.group('paired-comparison'), 'mouseenter');
  page.mouse(page.group('paired-comparison'), 'mouseleave');
  assert.equal(page.group('source-materials').classList.contains('active'), true);
  page.key(comparison, ' ');
  assert.notEqual(scene.style.transform, firstTransform);
  assert.equal(source.getAttribute('aria-pressed'), 'false');
  assert.equal(comparison.getAttribute('aria-pressed'), 'true');
  const back = page.document.querySelector('[data-reset-diagram]');
  back.focus();
  back.click();
  assertOverview(page);
  assert.equal(page.document.activeElement, comparison);

  // Navigation starts from the focused region, even when another region was selected.
  page.mouse(source);
  comparison.focus();
  page.key(comparison, 'ArrowRight');
  assert.equal(page.document.activeElement, page.trigger('formal-outcomes'));
  page.key(page.document.activeElement, 'ArrowUp');
  assert.equal(page.document.activeElement, comparison);
  page.key(comparison, 'End');
  assert.equal(page.document.activeElement, page.trigger('text-only-rewrite'));
  page.key(page.document.activeElement, 'Home');
  assert.equal(page.document.activeElement, source);
  page.key(source, 'Escape');
  assertOverview(page);
  assert.equal(page.document.activeElement, source);
  page.mouse(comparison);
  page.mouse(comparison);
  assertOverview(page);
});

test('紧凑机制图按转换后区域缩放，跨断点重排不重复挂载或丢失交互', t => {
  const page = environment(t);
  const flow = page.window.ReportFlow;
  const render = flow.render;
  const mount = page.window.ReportDiagram.mount;
  let options;
  let renderCount = 0;
  page.window.ReportDiagram.mount = (root, args) => {
    options = args;
    return mount(root, args);
  };
  flow.render = (...args) => {
    renderCount++;
    const controller = render(...args);
    page.controllers.add(controller);
    return controller;
  };
  page.window.innerWidth = 716;
  let controller = flow.render(page.document.getElementById('flowBody'), page.window.EvaluationReportData);
  const checkCompact = () => {
    assert.equal(page.document.getElementById('evaluationMechanism').getAttribute('viewBox'), '0 0 960 920');
    assert.equal(page.document.querySelector('.research-figure').classList.contains('compact-figure'), true);
    for (const region of options.regions) {
      const transform = page.group(region.id).getAttribute('transform').match(/^translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)$/);
      assert.ok(transform);
      const [dx, dy, scale] = transform.slice(1).map(Number);
      const trigger = page.trigger(region.id);
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => Number(trigger.getAttribute(name)));
      assert.deepEqual(Array.from(region.bounds), [x * scale + dx, y * scale + dy, width * scale, height * scale]);
      const [left, top, w, h] = region.bounds;
      assert.ok(left >= 0 && top >= 0 && left + w <= 960 && top + h <= 920, `${region.id} 操作区域应位于紧凑画布内`);
    }
  };
  const checkControls = () => {
    assert.equal(page.document.querySelectorAll('#evaluationMechanism,#mechanismScene,[data-reset-diagram]').length, 3);
    assert.equal(page.document.querySelectorAll('.region-hit[role="button"]').length, 8);
    assert.deepEqual([...page.document.querySelectorAll('[data-region]')].map(node => node.dataset.region), regionIds);
    assertMapping(page);
    page.mouse(page.trigger('identity-mapping'));
    assertMapping(page, true);
    page.mouse(page.trigger('identity-mapping'));
    assertMapping(page);
  };
  checkCompact();
  checkControls();
  const comparison = page.trigger('paired-comparison');
  page.mouse(comparison);
  const transform = page.document.getElementById('mechanismScene').style.transform.match(/^translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)$/);
  assert.ok(transform);
  const [tx, ty, zoom] = transform.slice(1).map(Number);
  const [x, y, width, height] = options.regions.find(region => region.id === 'paired-comparison').bounds;
  assert.ok(zoom > 1 && zoom <= 2.5);
  assert.ok(Math.abs(tx + (x + width / 2) * zoom - 480) < 0.5, '缩放区域应居中于紧凑画布宽度');
  assert.ok(Math.abs(ty + (y + height / 2) * zoom - 460) < 0.5, '缩放区域应居中于紧凑画布高度');
  page.key(comparison, 'Escape');
  assertOverview(page);

  const initialScene = page.document.getElementById('mechanismScene');
  page.window.innerWidth = 700;
  page.window.dispatchEvent(new page.window.Event('resize'));
  assert.equal(renderCount, 1, '同一断点内的 resize 不重绘');
  assert.equal(page.document.getElementById('mechanismScene'), initialScene);
  for (const [width, expectedCount, compact] of [[761, 2, false], [760, 3, true], [1280, 4, false], [716, 5, true]]) {
    page.window.innerWidth = width;
    page.window.dispatchEvent(new page.window.Event('resize'));
    assert.equal(renderCount, expectedCount, '每次跨断点只允许一个 resize 监听器重新绘制');
    assertOverview(page);
    checkControls();
    if (compact) checkCompact();
    else {
      assert.equal(page.document.getElementById('evaluationMechanism').getAttribute('viewBox'), '0 0 1280 620');
      assert.equal(page.document.querySelector('.compact-figure'), null);
      assert.equal(page.document.querySelector('[data-region][transform]'), null);
    }
  }
  controller = [...page.controllers].at(-1);
  controller.destroy();
  page.window.innerWidth = 1280;
  page.window.dispatchEvent(new page.window.Event('resize'));
  assert.equal(renderCount, 5, '销毁流程图后也应释放 resize 监听器');
});

test('真实案例快照保留来源边界，匿名演示不改写实测统计', t => {
  const page = environment(t);
  const report = page.window.EvaluationReportData;
  const metricsBefore = JSON.stringify(report.metrics);
  const recordsBefore = JSON.stringify(report.records);
  const example = report.mechanismCase;
  const provenance = example.provenance;
  assert.equal(example.kind, 'recorded');
  assert.equal(example.question, provenance.question_exact);
  assert.equal(example.reference, provenance.standard_answer_exact);
  assert.equal(example.unit, '个百分点');
  assert.match(example.reference, /个百分点$/);
  assert.deepEqual(Array.from(example.initialLabels), ['B', 'A']);
  assert.equal(example.winnerIndex, 1);
  assert.deepEqual(Array.from(example.candidates, candidate => candidate.usable), [false, true]);
  assert.deepEqual(Array.from(example.candidates, candidate => candidate.result), ['+1.25', '−0.60']);
  assert.match(example.candidates[1].formula, /中值近似/, '必须保留近似口径，不能暗示直接披露的年均利率');


  const controller = page.window.ReportFlow.render(page.document.getElementById('flowBody'), report);
  page.controllers.add(controller);
  const description = page.document.getElementById('mechanismDescription').textContent;
  assert.ok(description.includes(provenance.run_id));
  assert.ok(description.includes(provenance.evaluator_version_for_this_case));
  assert.match(description, /不表示再次调用裁判/);
  const values = selector => [...page.document.querySelectorAll(selector)].map(node => node.textContent);
  assert.deepEqual(values('#source-materials .answer-formula'), Array.from(example.candidates, candidate => candidate.formula));
  assert.deepEqual(values('#source-materials .answer-number'), Array.from(example.candidates, candidate => candidate.result));
  for (const [index, candidate] of example.candidates.entries()) {
    const evidence = page.document.querySelector(`.evidence-sheet[data-source-candidate="${index}"]`).textContent;
    assert.ok(evidence.includes(candidate.check));
    assert.ok(evidence.includes(candidate.finding));
    assert.doesNotMatch(evidence, /计算 ✓/);
  }
  assert.deepEqual(values('#identity-mapping .packet-number'), Array.from(example.candidates, candidate => candidate.result));
  assert.deepEqual(values('#identity-mapping .packet-source'), ['证据①', '证据②']);
  assert.deepEqual(values('#comparison-grid .matrix-basis'), Array.from(example.candidates, candidate => candidate.basis));
  assert.deepEqual(values('#comparison-grid .matrix-value'), Array.from(example.candidates, candidate => candidate.result));
  assert.deepEqual(values('#comparison-grid .matrix-core'), ['不可用', '可用']);
  for (const id of ['problem-clustering', 'text-only-rewrite']) assert.match(page.group(id).textContent, /本次未启用/);
  assert.equal(provenance.downstream.clustering.accepted_for_this_case, false);
  assert.equal(provenance.downstream.rewrite.accepted_for_this_case, false);
  assert.equal(Object.hasOwn(example, 'rewrite'), false, '不构造本例不存在的润色前后');
  assertMapping(page);
  page.mouse(page.trigger('identity-mapping'));
  assertMapping(page, true);
  assert.equal(JSON.stringify(report.metrics), metricsBefore);
  assert.equal(JSON.stringify(report.records), recordsBefore, '页面演示不追加真实对局或补充记录');
});

test('本地原始材料存在时逐条核对真实案例出处', async t => {
  const page = environment(t);
  const example = page.window.EvaluationReportData.mechanismCase;
  const provenance = example.provenance;
  const statePath = join(directory, '..', 'data/runs/comparison', provenance.run_id, 'state.json');
  const sourceFiles = [provenance.criteria.complete_result.file, provenance.comparison.complete_result.file,
    ...provenance.lanes.flatMap(lane => [lane.input.file, lane.attribution.complete_result.file])];
  try {
    await Promise.all([statePath, ...sourceFiles.map(file => join(directory, '..', file))].map(file => access(file)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('未提供本地原始输入或运行结果；离线快照与交互测试仍执行。');
    return;
  }
  const isCase = record => {
    const identity = record.case || record;
    return identity.batch_id === provenance.case.batch_id && identity.case_id === provenance.case.case_id;
  };
  const criteria = await sourceRecord(provenance.criteria.complete_result.file, provenance.case.case_id, record => isCase(record) && record.task_id === provenance.criteria.complete_result.task_id);
  assert.equal(criteria.evaluator_version, provenance.evaluator_version_for_this_case);
  assert.equal(criteria.result.task_type, provenance.criteria.task_type_exact);
  const sharedCriteria = criteria.result.requirements.filter(item => item.applies_to.length === 0);
  assert.deepEqual(sharedCriteria, plain(provenance.criteria.shared));
  assert.equal(example.sharedCriteriaCount, sharedCriteria.length);
  const attributions = [];
  for (const [index, lane] of provenance.lanes.entries()) {
    const candidate = example.candidates[index];
    const input = await sourceRecord(lane.input.file, provenance.case.case_id, record => isCase(record) && record.version === lane.input.recorded_version);
    assert.equal(valueAt(input, lane.input.question_path), example.question);
    assert.equal(valueAt(input, lane.input.reference_path), example.reference);
    assert.equal(candidate.model, lane.source_display_name);
    assert.equal(candidate.messageIndex, lane.final_message_index_0_based);
    assert.equal(example.initialLabels[index], lane.original_blind_label);
    assert.equal(provenance.comparison.actual_blind_mapping[example.initialLabels[index]], lane.version);
    for (const excerpt of lane.exact_final_excerpts) {
      const original = valueAt(input, excerpt.path);
      assert.equal(typeof original, 'string');
      assert.ok(original.includes(excerpt.text), `${lane.version} 摘录应逐字来自 ${excerpt.path}`);
    }
    assert.ok(lane.exact_final_excerpts.some(excerpt => excerpt.text === candidate.quote));
    const attribution = await sourceRecord(lane.attribution.complete_result.file, provenance.case.case_id, record => isCase(record) && record.task_id === lane.attribution.complete_result.task_id);
    attributions.push(attribution);
    assert.equal(attribution.version, lane.version);
    assert.equal(attribution.evaluator_version, provenance.evaluator_version_for_this_case);
    assert.equal(attribution.evaluator_version, lane.attribution.complete_result.evaluator_version);
    const evaluation = attribution.evaluation;
    assert.equal(evaluation.is_correct, lane.attribution.is_correct);
    assert.equal(evaluation.core_assessment.meets_core, candidate.usable);
    assert.equal(evaluation.core_assessment.meets_core, lane.attribution.meets_core);
    assert.equal(evaluation.core_assessment.reason, lane.attribution.core_reason_exact);
    assert.deepEqual(evaluation.numeric_checks, plain(lane.attribution.numeric_checks));
    assert.ok(evaluation.correctness_evidence.some(evidence => evidence.message_index === candidate.messageIndex && evidence.quote.includes(candidate.quote)));
    const decisive = lane.attribution.decisive_finding;
    const finding = evaluation.findings[decisive.finding_index_0_based];
    assert.equal(finding.finding_id, decisive.finding_id);
    assert.equal(finding.text, decisive.text_exact);
    assert.equal(finding.type, decisive.type);
    assert.equal(finding.importance, decisive.importance);
    assert.deepEqual(finding.problem?.component || null, plain(decisive.component));
    assert.equal(Object.hasOwn(evaluation, 'rewritten'), false, '本案例没有已接受的归因润色');
  }
  const comparison = await sourceRecord(provenance.comparison.complete_result.file, provenance.case.case_id, record => isCase(record) && record.comparison_id === provenance.comparison.complete_result.comparison_id);
  assert.equal(comparison.evaluator_version, provenance.evaluator_version_for_this_case);
  assert.equal(comparison.status, provenance.comparison.status);
  assert.equal(comparison.criteria_task_id, criteria.task_id);
  assert.deepEqual(Object.values(comparison.attribution_task_ids).sort(), attributions.map(row => row.task_id).sort());
  assert.deepEqual(comparison.ranking, plain(provenance.comparison.ranking));
  assert.equal(comparison.decision_basis.tradeoff, provenance.comparison.tradeoff_exact);
  assert.deepEqual(comparison.decision_basis.decisive_findings, plain(provenance.comparison.decisive_findings));
  const verdicts = Object.values(comparison.verdicts);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].result, provenance.comparison.outcome);
  assert.equal(verdicts[0].reason, provenance.comparison.reason_exact);
  assert.equal(verdicts[0].winner_version, provenance.lanes[example.winnerIndex].version);
  assert.equal(verdicts[0].winner_version, provenance.comparison.winner_version);
  assert.equal(provenance.comparison.winner_answer_number, example.winnerIndex + 1);
  assert.equal(provenance.comparison.winner_original_blind_label, example.initialLabels[example.winnerIndex]);
  assert.equal(Object.hasOwn(comparison, 'rewritten'), false);
  const runState = JSON.parse(await readFile(statePath, 'utf8'));
  const task = runState.tasks[provenance.comparison.state_task_id];
  assert.equal(task.data.comparisonId, comparison.comparison_id);
  assert.equal(task.receipt.evaluatorVersion, comparison.evaluator_version);
  for (const [index, lane] of provenance.lanes.entries()) {
    assert.equal(task.dependencies[example.initialLabels[index]], attributions[index].task_id);
    assert.equal(task.inputIds[example.initialLabels[index]], attributions[index].input_id);
    assert.equal(comparison.assessments[lane.version].meets_core, example.candidates[index].usable);
  }

});

test('A/B 换位联动匿名标签、表头与胜者代号，固定来源且不修改报告数据', t => {
  const page = diagram(t);
  const before = JSON.stringify(page.window.EvaluationReportData);
  const sourcePackages = page.document.querySelector('#shared-rubric-and-attribution').innerHTML;
  const swap = page.trigger('identity-mapping');
  assertMapping(page);
  page.mouse(swap);
  assertMapping(page, true);
  assert.equal(swap.getAttribute('aria-pressed'), 'true');
  assertOverview(page);
  page.mouse(page.trigger('paired-comparison'));
  page.document.querySelector('[data-reset-diagram]').click();
  assertMapping(page, true);
  page.mouse(page.trigger('formal-outcomes'));
  page.window.dispatchEvent(new page.window.Event('beforeprint'));
  assertOverview(page);
  page.window.dispatchEvent(new page.window.Event('afterprint'));
  assertMapping(page, true);
  page.key(swap, 'Enter');
  assertMapping(page);
  assert.equal(swap.getAttribute('aria-pressed'), 'false');
  assert.equal(page.document.querySelector('#shared-rubric-and-attribution').innerHTML, sourcePackages);
  assert.equal(JSON.stringify(page.window.EvaluationReportData), before);
});

test('真实图重复挂载只保留一套事件，destroy 后不再响应', t => {
  const page = diagram(t);
  let calls = 0;
  const options = { ...page.options, onSwap() { calls++; page.options.onSwap(); } };
  const first = page.window.ReportDiagram.mount(page.root, options);
  page.controllers.add(first);
  const current = page.window.ReportDiagram.mount(page.root, options);
  page.controllers.add(current);
  page.mouse(page.trigger('identity-mapping'));
  assert.equal(calls, 1);
  assertMapping(page, true);
  first.destroy();
  page.mouse(page.trigger('paired-comparison'));
  assert.ok(page.document.getElementById('mechanismScene').style.transform);
  current.destroy();
  assertOverview(page);
  page.mouse(page.trigger('source-materials'));
  page.mouse(page.trigger('identity-mapping'));
  assertOverview(page);
  assert.equal(calls, 1);
  const status = page.document.querySelector('[data-diagram-status]');
  status.textContent = '监听已释放';
  page.window.dispatchEvent(new page.window.Event('beforeprint'));
  assert.equal(status.textContent, '监听已释放');
});

test('构建产物重开保留完整内容，恢复总览并支持提示词原文下载', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'evaluation-interaction-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const output = await buildReport({ output: join(temporary, 'report.html') });
  const html = await readFile(output, 'utf8');
  const page = environment(t, html, true);
  const before = JSON.stringify(page.window.EvaluationReportData);
  assert.equal(page.document.getElementById('exportHtmlBtn'), null);
  assert.equal(page.document.getElementById('flowScope'), null);
  assert.ok(page.document.getElementById('caseExample'));
  assertMapping(page);
  page.mouse(page.trigger('identity-mapping'));
  assertMapping(page, true);
  page.mouse(page.trigger('paired-comparison'));
  page.mouse(page.group('source-materials'), 'mouseenter');
  page.document.querySelector('[data-page="prompts"]').click();
  page.document.getElementById('downloadPromptsBtn').click();
  assert.equal(page.downloads.length, 1);
  assert.equal(page.downloads[0].name, '评测提示词原文.txt');
  const prompts = await page.downloadText();
  for (const prompt of page.window.EvaluationReportData.prompts) {
    assert.ok(prompts.includes(prompt.path), `下载应保留 ${prompt.path}`);
    assert.ok(prompts.includes(prompt.text), `下载应完整保留 ${prompt.name}`);
  }
  assert.equal(JSON.stringify(page.window.EvaluationReportData), before);
  const reopened = environment(t, html, true);
  assert.equal(JSON.stringify(reopened.window.EvaluationReportData), before);
  assert.equal(reopened.document.querySelector('.page:not([hidden])').id, 'page-flow');
  assert.equal(reopened.document.querySelectorAll('.page').length, 4);
  assert.equal(reopened.document.querySelectorAll('script').length, 6);
  assert.equal(reopened.document.querySelectorAll('script[src],link[rel="stylesheet"],iframe,image').length, 0);
  assert.equal(reopened.document.querySelectorAll('[data-region]').length, 8);
  assertOverview(reopened);
  assert.equal(reopened.document.querySelector('#mechanismScene .active,#mechanismScene .related,#mechanismScene .muted'), null);
  assertMapping(reopened);
  for (const topic of ['rules', 'prompts', 'experiments', 'flow']) {
    reopened.document.querySelector(`[data-page="${topic}"]`).click();
    assert.equal(reopened.document.querySelector('.page:not([hidden])').id, `page-${topic}`);
  }
  reopened.mouse(reopened.trigger('identity-mapping'));
  assertMapping(reopened, true);
});
