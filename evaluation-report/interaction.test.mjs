import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildReport } from './build.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const scriptNames = ['data', 'motion', 'icons', 'diagram-interaction', 'flow', 'rules', 'prompts'];
const [sourceHtml, ...sources] = await Promise.all([
  readFile(join(directory, 'index.html'), 'utf8'),
  ...scriptNames.map(name => readFile(join(directory, `src/${name}.js`), 'utf8')),
]);
const plain = value => JSON.parse(JSON.stringify(value));
const atPointer = (value, pointer) => pointer.split('/').slice(1).reduce((item, key) => item?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], value);
const regionIds = [
  'source-materials', 'shared-rubric-and-attribution', 'identity-mapping', 'paired-comparison',
  'formal-outcomes', 'bounded-review', 'problem-attribution',
];

function environment(t, html = sourceHtml, inline = false) {
  const errors = [];
  const controllers = new Set();
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {
    // No resource loader is configured: these checks cannot use network or repository files in the page.
    url: 'https://offline-report.invalid/report.html',
    runScripts: inline ? 'dangerously' : 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: console,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.matchMedia = () => ({ matches: true, addEventListener() {} });
    },
  });
  t.after(() => {
    try {
      controllers.forEach(controller => controller.destroy());
      assert.deepEqual(errors, [], '页面执行不能产生未捕获错误');
    } finally { dom.window.close(); }
  });
  if (!inline) sources.forEach(source => dom.window.eval(source));
  const document = dom.window.document;
  return {
    window: dom.window, document, controllers,
    group: id => document.querySelector(`[data-region="${id}"]`),
    mouse(element, type = 'click') { element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: type === 'click' })); },
    key(element, key) {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event;
    },
    selectCase(index) {
      const select = document.querySelector('[data-case-select]');
      select.value = String(index);
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    swap() { document.querySelector('[data-swap-control]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); },
    flow() {
      const controller = dom.window.ReportFlow.render(document.getElementById('flowBody'), dom.window.EvaluationReportData);
      controllers.add(controller);
      return controller;
    },
  };
}

function assertMapping(page, item, swapped = false) {
  const labels = Array.from(item.candidates, candidate => candidate.label);
  if (swapped) labels.reverse();
  assert.deepEqual([...page.document.querySelectorAll('#identity-mapping .identity-label')].map(node => node.textContent), labels);
  assert.deepEqual([...page.document.querySelectorAll('#comparison-grid .matrix-header[data-candidate-identity]')].map(node => node.textContent), labels);
  assert.deepEqual([...page.document.querySelectorAll('#problem-attribution .attribution-identity')].map(node => node.textContent), labels);
  for (const node of page.document.querySelectorAll('[data-candidate-identity]')) {
    assert.equal(node.textContent, labels[Number(node.dataset.candidateIdentity)], '逐项优劣、专属范围和最终取舍都使用当前匿名身份');
  }
  const winner = item.winnerIndex === null ? (item.outcome === 'both_good' ? '都好' : '都差') : `${labels[item.winnerIndex]} 胜`;
  assert.equal(page.document.getElementById('winnerLabel').textContent, winner);
  assert.equal(page.document.getElementById('sourceWinner').textContent, item.winnerIndex === null ? '' : item.candidates[item.winnerIndex].source);
  assert.equal(page.document.querySelector('[data-swap-control]').getAttribute('aria-pressed'), String(swapped));
  const anonymousText = value => value.replaceAll('回答①', labels[0]).replaceAll('回答②', labels[1]);
  assert.equal(page.document.querySelector('[data-verdict-reason]').textContent, anonymousText(item.presentation.decision.summary));
  const caution = page.document.querySelector('[data-verdict-caution]');
  if (item.presentation.decision.caveat) assert.equal(caution.textContent, anonymousText(item.presentation.decision.caveat));
  else assert.equal(caution, null);
}

function matrixCells(page) {
  return [...page.document.querySelectorAll('.matrix-cell')].map(cell => {
    const marker = cell.querySelector('[data-cell-judgment]');
    return {
      row: cell.closest('[data-matrix-row]').dataset.matrixRow,
      candidate: cell.dataset.cellCandidate,
      value: cell.querySelector('.matrix-basis').textContent,
      state: marker.dataset.cellJudgment,
      symbol: marker.dataset.symbol,
      partial: marker.dataset.partial,
      label: marker.getAttribute('aria-label'),
    };
  });
}

function assertCaseContent(page, item) {
  assert.equal(page.document.querySelector('[data-overview-question]').textContent, item.question);
  const standardAnswer = page.document.querySelector('[data-standard-answer]');
  assert.equal(page.document.querySelector('.case-kind').textContent, item.hasStandardAnswer ? '客观题' : '主观题');
  if (item.hasStandardAnswer) {
    assert.ok(standardAnswer, '正式Has Standard Answer为true的客观题展示真实标准答案');
    assert.equal(standardAnswer.tagName.toLowerCase(), 'g');
    assert.equal(standardAnswer.closest('[data-region]'), page.group('source-materials'));
    assert.equal(standardAnswer.closest('svg'), page.document.getElementById('evaluationMechanism'));
    assert.equal(standardAnswer.dataset.answerAvailable, 'true');
    assert.equal(standardAnswer.closest('[hidden],details,template'), null);
    const value = standardAnswer.querySelector('text[data-standard-answer-value]');
    assert.ok(value, '客观题必须有真实标准答案值');
    assert.equal(value.textContent, item.groundTruth.value, '标准答案逐字保留源数据，不随A/B换位改变');
    assert.ok([...standardAnswer.querySelectorAll('text:not([data-standard-answer-value])')].some(node => node.textContent === '标准答案'));
  } else {
    assert.equal(standardAnswer, null, '主观题不显示标准答案区');
  }
  assert.ok(!page.document.getElementById('mechanismScene').textContent.includes('本次评测未附标准答案'));
  assert.equal(page.document.querySelector('#active-case').children.length, 1, '正文完全保留在同一机制图');
  assert.equal(page.document.querySelector('#active-case').firstElementChild.tagName, 'FIGURE');
  assert.deepEqual([...page.document.querySelectorAll('[data-checklist-item]')].map(node => node.textContent), Array.from(item.presentation.checklist));
  assert.equal(page.document.querySelectorAll('#comparison-grid .matrix-header').length, 3, '矩阵只有对照项与两份回答三列');
  assert.equal(page.document.querySelector('[data-row-judgment],[data-judgment-note],.matrix-judgment-header'), null, '原判优劣不再单占第四列');
  const legend = page.document.querySelector('[data-matrix-legend]').textContent;
  assert.match(legend, /✓ 较优.*× 较弱.*— 未判/);
  for (const [selector, description] of [
    ['[data-cell-judgment="not-applicable"]', '∅ 不适用'],
    ['[data-cell-judgment="uncertain"]', '? 待核实'],
    ['[data-cell-judgment][data-partial="true"]', '* 部分项'],
  ]) {
    assert.equal(legend.includes(description), Boolean(page.document.querySelector(selector)), '图例只解释当前案例出现的特殊符号');
  }
  const rows = [...page.document.querySelectorAll('#comparison-grid .matrix-row')];
  assert.equal(rows.length, item.presentation.matrixRows.length);
  rows.forEach((node, index) => {
    const row = item.presentation.matrixRows[index];
    assert.deepEqual([...node.querySelectorAll('.matrix-row-label,.matrix-basis')].map(text => text.textContent), [row.label, ...Array.from(row.values)]);
    const cells = [...node.querySelectorAll('.matrix-cell')];
    assert.deepEqual(cells.map(cell => cell.dataset.cellCandidate), ['0', '1'], '符号固定绑定原回答，不能随匿名代号换到另一列');
    for (const cell of cells) {
      assert.equal(cell.querySelectorAll('[data-cell-judgment]').length, 1);
      const marker = cell.querySelector('[data-cell-judgment]');
      const meanings = {
        better: ['✓', '原判相对较优'], worse: ['×', '原判相对较弱'], neutral: ['—', '原判未判优劣'],
        'not-applicable': ['∅', '不适用'], uncertain: ['?', '待核实'],
      };
      const meaning = meanings[marker.dataset.cellJudgment];
      assert.ok(meaning, '单元格标记只使用明确的比较状态');
      assert.ok(['true', 'false'].includes(marker.dataset.partial));
      const partial = marker.dataset.partial === 'true';
      if (partial) assert.ok(['better', 'worse'].includes(marker.dataset.cellJudgment));
      assert.equal(marker.dataset.symbol, meaning[0] + (partial ? '*' : ''));
      assert.equal(marker.getAttribute('aria-label'), meaning[1] + (partial ? '（仅部分比较项）' : ''));
      assert.equal(marker.getAttribute('role'), 'img');
    }
    assert.equal(node.querySelector('[data-row-caution]')?.textContent || '', row.caution || '', '原判疑点仍跟随对应对照项');
    assert.equal(node.dataset.comparisonIndices, row.comparisonIndices.join(','));
    assert.equal(node.closest('[hidden],details,template'), null, '全部比较摘要无需打开浮层即可阅读');
  });
  item.candidates.forEach((candidate, index) => {
    const node = page.document.querySelector(`.evidence-sheet[data-source-candidate="${index}"]`);
    assert.ok(node.textContent.includes(candidate.core.meets_core ? '核心可用' : '核心不可用'));
    assert.ok(node.textContent.includes(item.presentation.check[index]));
    assert.ok(node.textContent.includes(item.presentation.finding[index]));
  });
  const attribution = page.group('problem-attribution');
  assert.ok(attribution, '问题归因与机制图一起直接呈现');
  assert.equal(attribution.querySelectorAll('[data-problem-candidate]').length, item.candidates.length);
  item.candidates.forEach((candidate, index) => {
    const node = attribution.querySelector(`[data-problem-candidate="${index}"]`);
    assert.ok(node, `${candidate.source}的问题不能挪给另一回答`);
    assert.ok(node.querySelector(`text.attribution-identity[data-candidate-identity="${index}"]`));
    const expected = Array.from(candidate.findings).filter(finding => finding.type === 'problem' && finding.problem.component.length > 0);
    const groups = [...node.querySelectorAll('[data-finding-ids]')];
    const ids = groups.flatMap(group => group.dataset.findingIds.split(' '));
    assert.deepEqual(ids.toSorted(), expected.map(finding => finding.finding_id).toSorted(), '所有真实问题均展示一次，并绑定原回答');
    const components = [];
    for (const group of groups) {
      const findings = group.dataset.findingIds.split(' ').map(id => expected.find(finding => finding.finding_id === id));
      assert.ok(findings.length && findings.every(Boolean));
      const component = Array.from(findings[0].problem.component);
      findings.forEach(finding => assert.deepEqual(Array.from(finding.problem.component), component, '相同归因组件才可合为一组'));
      components.push(component.join(' / '));
      const expectedText = `${component.join(' / ')}｜${findings.map(finding => `${finding.problem.label}${finding.assessment.evidence_status === 'uncertain' ? '（待核实）' : ''}`).join('；')}`;
      assert.equal(group.textContent, expectedText, '保留组件与完整问题标签，未确认问题逐项标记待核实');
    }
    assert.equal(new Set(components).size, components.length, '同一回答的相同组件合并展示');
    assert.equal(node.textContent.includes('未记录问题'), expected.length === 0);
    for (const finding of candidate.findings.filter(finding => finding.type === 'problem' && finding.problem.component.length === 0)) {
      assert.ok(!node.textContent.includes(finding.problem.label), '没有归因组件且不构成缺失的记录不能作为问题展示');
    }
  });
  assert.equal(page.group('problem-clustering'), null);
  assert.equal(page.group('text-only-rewrite'), null);
  assert.ok(!page.document.getElementById('mechanismScene').textContent.includes('评语润色'));
  assert.equal(page.document.querySelector('[data-region-detail],template[data-region-details],[data-reset-diagram],.region-hit,.case-matrix,.rewrite-pair,.class-assignment'), null);
  assert.equal(page.document.getElementById('mechanismScene').style.transform, '');
  assert.equal(page.document.querySelector('.research-figure').classList.contains('is-zoomed'), false);
}

test('至少十种真实问句保留标准与摘要来源，题型按正式Has Standard Answer区分且实验为空', t => {
  const page = environment(t);
  const report = page.window.EvaluationReportData;
  assert.ok(report.cases.length >= 10);
  assert.equal(new Set(report.cases.map(item => item.id)).size, report.cases.length);
  assert.equal(new Set(report.cases.map(item => item.question)).size, report.cases.length);
  assert.equal(report.cases.filter(item => item.hasStandardAnswer).length, 3);
  assert.equal(report.cases.filter(item => !item.hasStandardAnswer).length, 7);
  assert.deepEqual(plain(report.experiments), {versions: [], results: []});
  for (const item of report.cases) {
    assert.equal(typeof item.hasStandardAnswer, 'boolean');
    assert.equal(item.hasStandardAnswer, item.groundTruth.available, '题型以正式评测的标准答案可用标识为准，不能按问句性质推断');
    assert.ok(item.presentation.decision.summary.length > 0);
    assert.deepEqual(plain(item.presentation.decision.provenance), {...plain(item.provenance.comparison), pointer: '/decision_basis/tradeoff'}, '最终取舍摘要追溯到同一案例的原判取舍');
    assert.deepEqual(Array.from(item.presentation.checklist), Array.from(item.presentation.checklistProvenance, entry => entry.text));
    assert.ok(item.presentation.checklist.length >= 3);
    for (const entry of item.presentation.checklistProvenance) {
      assert.ok(['question', 'criteria'].includes(entry.source));
      assert.ok(entry.criterionIds.length > 0);
      const rules = entry.criterionIds.map(id => item.criteria.find(rule => rule.id === id));
      assert.ok(rules.every(Boolean), '每个清单要点必须指向真实判据');
      assert.ok(entry.sourceQuote.length > 0 && rules.some(rule => rule.text.includes(entry.sourceQuote)), '清单摘要需要保留支持它的连续原文');
      assert.ok(rules.some(rule => JSON.stringify(rule.provenance) === JSON.stringify(entry.provenance)), '清单来源应指向原判据记录');
      if (entry.source === 'question') assert.ok(rules.some(rule => rule.text.includes(item.question)), '问句拆解必须引用包含原问句的判据');
      if (entry.applicableIndices) {
        const applicable = Array.from(item.candidates).flatMap((candidate, index) => rules.every(rule => !rule.applies_to.length || rule.applies_to.includes(candidate.inputId)) ? [index] : []);
        assert.deepEqual(Array.from(entry.applicableIndices), applicable, '专属清单不能施加给未被原判据约束的候选');
      }
    }
    const covered = item.presentation.matrixRows.flatMap(row => row.comparisonIndices);
    assert.deepEqual(Array.from(covered).sort((a, b) => a - b), Array.from(item.comparisons, (_, index) => index), '摘要合并后仍需精确覆盖每条正式比较');
    for (const row of item.presentation.matrixRows) {
      assert.equal(row.values.length, item.candidates.length);
      const refs = Array.isArray(row.provenance) ? row.provenance : [row.provenance];
      assert.deepEqual(plain(refs), Array.from(row.comparisonIndices, index => plain(item.comparisons[index].provenance)));
    }
    assert.equal(item.criteriaSummary.shared, item.criteria.filter(rule => !rule.applies_to.length).length);
    const candidateIds = new Set(item.candidates.map(candidate => candidate.inputId));
    assert.equal(item.criteriaSummary.relevantCandidateSpecific, item.criteria.filter(rule => rule.applies_to.some(id => candidateIds.has(id))).length);
    assert.ok(item.comparisons.length > 0);
    item.comparisons.forEach((row, index) => {
      assert.equal(row.topic, row.originals.aspect);
      assert.deepEqual(Array.from(row.cells), Array.from(item.candidates, candidate => row.originals.assessments[candidate.version].summary));
      assert.deepEqual(Array.from(row.betterIndices), Array.from(item.candidates).flatMap((candidate, candidateIndex) => row.originals.better_candidates.includes(candidate.version) ? [candidateIndex] : []), '优势候选按真实version匹配，不能从A/B字母猜测');
      assert.equal(row.provenance.pointer, `/decision_basis/comparisons/${index}`, '全部行按原次序展示');
      for (const candidate of item.candidates) {
        const assessment = row.originals.assessments[candidate.version];
        assert.ok(assessment.finding_indices.every(index => Number.isInteger(index) && index >= 0 && index < candidate.findings.length));
      }
    });
    item.candidates.forEach(candidate => {
      assert.equal(typeof candidate.core.meets_core, 'boolean');
      assert.equal(item.provenance.blindMapping[candidate.label], candidate.inputId);
      assert.ok(candidate.answerExcerpt.length > 0);
      assert.equal(candidate.answerExcerptProvenance.characterLength, candidate.answerExcerpt.length);
      assert.equal(candidate.answerExcerptProvenance.matchVerified, true);
      assert.equal(candidate.provenance.task.evaluatorVersion, item.provenance.evaluatorVersion);
    });
    assert.equal(item.outcome, item.verdict.result);
    assert.equal(item.reason, item.verdict.reason);
    assert.equal(item.winnerIndex === null ? null : item.candidates[item.winnerIndex].version, item.verdict.winner_version);
    if (item.rewrite.records.length) {
      assert.equal(item.rewrite.before, item.reason);
      assert.ok(item.rewrite.after.length > 0);
      assert.ok(item.rewrite.tasks.every(task => task.status === 'succeeded'));
    }
    for (const record of item.clustering.records) {
      const candidate = item.candidates.find(candidate => candidate.version === record.version);
      const finding = candidate.findings.find(finding => finding.finding_id === record.findingId);
      assert.equal(record.findingLabel, finding.problem.label);
      assert.equal(record.occurrence.finding_id, record.findingId);
      assert.equal(record.occurrence.class_id, record.classId);
      assert.equal(record.evidenceStatus, record.occurrence.evidence_status);
      assert.ok(record.classLabel.length > 0);
      assert.equal(record.provenance.clusteringTask.status, 'succeeded');
    }
  }
});

test('案例选择、循环翻页与键盘切换更新整图，换位不改来源判决或快照', t => {
  const page = environment(t);
  page.flow();
  const report = page.window.EvaluationReportData;
  const before = JSON.stringify(report);
  let displayedProblems = 0;
  assert.equal(page.document.querySelectorAll('[data-case-select] option').length, report.cases.length);
  for (const [index, item] of report.cases.entries()) {
    page.selectCase(index);
    assert.equal(page.document.querySelector('[data-case-select]').value, String(index));
    assert.equal(page.document.querySelector('.case-kind').textContent, item.hasStandardAnswer ? '客观题' : '主观题');
    assertCaseContent(page, item);
    assertMapping(page, item);
    const cells = matrixCells(page);
    const cautions = [...page.document.querySelectorAll('[data-row-caution]')].map(node => node.textContent);
    const problemText = [...page.document.querySelectorAll('[data-problem-candidate]')].map(node => [...node.querySelectorAll('[data-finding-ids]')].map(group => group.textContent));
    displayedProblems += [...page.document.querySelectorAll('[data-finding-ids]')].reduce((count, group) => count + group.dataset.findingIds.split(' ').length, 0);
    page.swap();
    assertMapping(page, item, true);
    assertCaseContent(page, item);
    assert.deepEqual(matrixCells(page), cells, '匿名换位只改表头代号，原回答的值、符号、部分优势与可访问含义均不变');
    assert.deepEqual([...page.document.querySelectorAll('[data-row-caution]')].map(node => node.textContent), cautions, '匿名换位不改变原判疑点');
    assert.deepEqual([...page.document.querySelectorAll('[data-problem-candidate]')].map(node => [...node.querySelectorAll('[data-finding-ids]')].map(group => group.textContent)), problemText, '匿名换位只改字母，问题内容和原回答归属不变');
  }
  assert.equal(displayedProblems, 27, '十个真实案例的27项问题均已逐项展示');
  page.document.querySelector('[data-case-next]').click();
  assert.equal(page.document.querySelector('[data-case-select]').value, '0');
  assertMapping(page, report.cases[0]);
  assert.ok(page.document.activeElement.hasAttribute('data-case-next'));
  page.document.querySelector('[data-case-prev]').click();
  assert.equal(page.document.querySelector('[data-case-select]').value, String(report.cases.length - 1));
  assert.ok(page.document.activeElement.hasAttribute('data-case-prev'));
  for (const [key, index] of [['Home', 0], ['End', report.cases.length - 1], ['ArrowRight', 0], ['ArrowLeft', report.cases.length - 1]]) {
    const control = page.document.querySelector('[data-case-next]');
    assert.equal(page.key(control, key).defaultPrevented, true);
    assert.equal(page.document.querySelector('[data-case-select]').value, String(index));
    assert.equal(page.document.activeElement, page.document.querySelector('[data-case-select]'));
    assertMapping(page, report.cases[index]);
  }
  const select = page.document.querySelector('[data-case-select]');
  assert.equal(page.key(select, 'Home').defaultPrevented, false, '保留原生下拉框的键盘行为');
  assert.equal(page.document.querySelector('[data-case-select]').value, select.value);
  assert.equal(JSON.stringify(report), before);
});

test('Has Standard Answer为false的筛选任务归为主观题，0和57条查询结果不能补成标准答案', t => {
  const page = environment(t);
  page.flow();
  const index = page.window.EvaluationReportData.cases.findIndex(item => item.id === 'technical-fast');
  assert.ok(index >= 0);
  const item = page.window.EvaluationReportData.cases[index];
  assert.equal(item.hasStandardAnswer, false);
  assert.deepEqual(plain(item.groundTruth), {available: false, value: null});
  page.selectCase(index);
  const row = [...page.document.querySelectorAll('.matrix-row')].find(node => node.querySelector('.matrix-row-label').textContent === '原始筛选');
  assert.deepEqual([...row.querySelectorAll('.matrix-basis')].map(node => node.textContent), ['原条件0；放宽后57条参考候选', '原条件0；仅给3条放宽建议']);
  for (const swapped of [false, true]) {
    if (swapped) page.swap();
    assert.equal(page.document.querySelector('.case-kind').textContent, '主观题', '不能因问题涉及客观筛选条件就人工标为客观题');
    assert.equal(page.document.querySelector('[data-standard-answer]'), null);
    assert.equal(page.document.querySelector('[data-standard-answer-value]'), null, '候选回答和工具产物不是题库金标');
    assert.ok(!page.document.getElementById('mechanismScene').textContent.includes('本次评测未附标准答案'));
    assert.equal(page.document.querySelector('[data-overview-question]').textContent, item.question);
    assertMapping(page, item, swapped);
  }
});

test('单元格符号区分相对优劣、专属约束与未决证据，部分优势不冒充整项达标', t => {
  const page = environment(t);
  page.flow();
  const cases = page.window.EvaluationReportData.cases;
  const scenarios = [
    ['上证区间涨跌幅', [
      ['数据口径', ['—', '—']],
      ['数据来源', ['✓', '×']],
      ['走势展示', ['×', '✓']],
      ['格式风险', ['—', '∅']],
    ]],
    ['MACD双波峰筛选', [
      ['筛选口径', ['×', '✓'], '理由存疑'],
      ['专属要求', ['—', '∅']],
      ['开头风险', ['—', '∅']],
      ['解释取舍', ['∅', '—']],
    ]],
    ['四时段交易口诀', [
      ['集合竞价', ['✓*', '×*']],
      ['尾盘口诀', ['✓*', '×*']],
      ['表达规范', ['—', '—']],
      ['耗时与消耗', ['—', '—']],
    ]],
    ['福日电子上涨归因', [
      ['数值来源', ['—', '?']],
      ['耗时与消耗', ['×*', '✓*']],
    ]],
    ['掉期交割日期', [['问题覆盖', ['—', '∅'], '适用存疑']]],
    ['政策支持与竞争', [['表达规范', ['✓*', '×*']]]],
    ['银河证券利率', [
      ['核心数值', ['×', '✓']],
      ['专属格式', ['—', '∅']],
      ['表达瑕疵', ['—', '—']],
      ['资源效率', ['✓', '×']],
    ]],
    ['三季报披露家数', [
      ['核心家数', ['×', '✓']],
      ['时点推断', ['—', '—']],
    ]],
  ];
  for (const [title, expectations] of scenarios) {
    const index = cases.findIndex(item => item.title === title);
    assert.ok(index >= 0);
    page.selectCase(index);
    for (const [label, symbols, caution = ''] of expectations) {
      const row = [...page.document.querySelectorAll('.matrix-row')].find(node => node.querySelector('.matrix-row-label').textContent === label);
      assert.ok(row, `${title} / ${label}`);
      assert.deepEqual([...row.querySelectorAll('[data-cell-judgment]')].map(node => node.dataset.symbol), symbols, `${title} / ${label}`);
      assert.equal(row.querySelector('[data-row-caution]')?.textContent || '', caution, `${title} / ${label}`);
    }
    if (title === '银河证券利率') {
      assert.deepEqual([...page.document.querySelectorAll('#comparison-grid .matrix-header[data-candidate-identity]')].map(node => node.textContent), ['B', 'A'], '银河证券真实回答①对应匿名B，不能反向解释×和✓');
      assert.equal(page.document.getElementById('winnerLabel').textContent, 'A 胜');
    }
  }
  assert.equal(page.document.getElementById('winnerLabel').textContent, '都差', '核心均失败时，单项相对优势不能通过多数票变成总胜者');
  assert.match(page.document.querySelector('[data-verdict-reason]').textContent, /双方未交付18时1828家/);
  page.swap();
  assert.equal(page.document.getElementById('winnerLabel').textContent, '都差');
  assertMapping(page, cases.find(item => item.title === '三季报披露家数'), true);
});

test('七区总览只高亮连线，不缩放或打开浮层；匿名换位支持鼠标和键盘', t => {
  const page = environment(t);
  page.flow();
  const item = page.window.EvaluationReportData.cases[0];
  assert.deepEqual([...page.document.querySelectorAll('[data-region]')].map(node => node.dataset.region), regionIds);
  const scene = page.document.getElementById('mechanismScene');
  for (const id of regionIds) {
    const group = page.group(id);
    page.mouse(group, 'mouseenter');
    assert.equal(scene.querySelectorAll('[data-region].active,[data-region].muted').length, 0, '只强调流向，不把正文变淡');
    page.mouse(group);
    assertCaseContent(page, item);
    page.mouse(group, 'mouseleave');
    assert.equal(scene.querySelectorAll('.connections.active').length, 0);
  }
  page.mouse(page.group('source-materials'), 'mouseenter');
  assert.ok(scene.querySelector('[data-owner="shared-rubric-and-attribution"]').classList.contains('active'));
  page.mouse(page.group('source-materials'), 'mouseleave');
  const swap = page.document.querySelector('[data-swap-control]');
  assert.equal(swap.getAttribute('role'), 'button');
  assert.equal(swap.getAttribute('tabindex'), '0');
  swap.focus();
  assert.equal(page.key(swap, 'Enter').defaultPrevented, true);
  assertMapping(page, item, true);
  assert.equal(page.key(swap, ' ').defaultPrevented, true);
  assertMapping(page, item);
  page.swap();
  assertMapping(page, item, true);
  page.key(swap, 'Escape');
  assertMapping(page, item, true);
  assertCaseContent(page, item);
  const ids = [...page.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const path of scene.querySelectorAll('[marker-end]')) {
    const marker = path.getAttribute('marker-end').match(/^url\(#([\w-]+)\)$/)?.[1];
    assert.equal(page.document.getElementById(marker)?.tagName.toLowerCase(), 'marker');
  }
});

test('1080断点重排保持案例与匿名映射，重挂载销毁释放旧交互', t => {
  const page = environment(t);
  const first = page.flow();
  const oldRoot = page.document.querySelector('.research-figure');
  const oldSwap = page.document.querySelector('[data-swap-control]');
  const oldSource = page.group('source-materials');
  page.selectCase(1);
  page.swap();
  const item = page.window.EvaluationReportData.cases[1];
  page.mouse(oldSwap);
  assert.equal(oldSwap.getAttribute('aria-pressed'), 'false', '已卸载图的换位事件应释放');
  page.mouse(oldSource, 'mouseenter');
  assert.equal(oldRoot.querySelectorAll('.connections.active').length, 0);
  assertMapping(page, item, true);
  for (const width of [1081, 1080, 716, 1540]) {
    page.window.innerWidth = width;
    page.window.dispatchEvent(new page.window.Event('resize'));
    assert.equal(page.document.querySelector('[data-case-select]').value, '1');
    assertMapping(page, item, true);
    assertCaseContent(page, item);
    const [, , viewWidth, height] = page.document.getElementById('evaluationMechanism').getAttribute('viewBox').split(/\s+/).map(Number);
    assert.equal(viewWidth, width <= 1080 ? 820 : 1660);
    assert.ok(Number.isFinite(height) && height > 0);
    assert.equal(page.document.querySelectorAll('#evaluationMechanism,#mechanismScene,[data-swap-control]').length, 3);
    assert.equal(page.document.querySelectorAll('[data-region]').length, regionIds.length);
    assert.ok([...page.document.querySelectorAll('#evaluationMechanism text')].every(node => Number(node.getAttribute('y')) >= 0 && Number(node.getAttribute('y')) <= height), '正文基线应位于自适应画布内');
  }
  const current = page.flow();
  first.destroy();
  page.swap();
  assertMapping(page, page.window.EvaluationReportData.cases[0], true);
  current.destroy();
  const content = page.document.getElementById('flowBody').innerHTML;
  page.swap();
  page.document.querySelector('[data-case-next]').click();
  page.selectCase(2);
  page.mouse(page.group('source-materials'), 'mouseenter');
  page.window.innerWidth = 716;
  page.window.dispatchEvent(new page.window.Event('resize'));
  assert.equal(page.document.getElementById('flowBody').innerHTML, content);
});

test('判决树四种正式路径与不交付路径可选择，按 Escape 恢复全部路径', t => {
  const page = environment(t);
  const container = page.document.getElementById('rulesBody');
  const controller = page.window.ReportRules.render(container, page.window.EvaluationReportData);
  page.controllers.add(controller);
  const states = ['single', 'neither', 'difference'].map(id => container.querySelector(`[data-rule-node="${id}"]`));
  assert.deepEqual(states.map(node => node.textContent), ['仅一方可用', '双方不可用', '双方可用有实质差距？']);
  assert.ok(states.every(node => node.tagName === 'DIV' && node.parentElement === container.querySelector('.rules-tree')), '三种可用状态并列呈现，继续分支不混作最终结果');
  const results = [...container.querySelectorAll('[data-rule-result]')];
  assert.deepEqual(results.map(node => node.textContent), ['不交付', '可用者胜', '都差', '优势者胜', '都好']);
  for (const button of results) {
    button.click();
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(container.querySelectorAll('[data-rule-result][aria-pressed="true"]').length, 1);
    for (const node of container.querySelectorAll('[data-rule-node].on-rule-path')) {
      assert.ok(node.dataset.ruleRoutes.split(' ').includes(button.dataset.ruleResult));
    }
    page.key(button, 'Escape');
    assert.equal(container.querySelectorAll('[aria-pressed="true"],.on-rule-path').length, 0);
  }
  const oldButton = results[0];
  const next = page.window.ReportRules.render(container, page.window.EvaluationReportData);
  page.controllers.add(next);
  oldButton.click();
  assert.equal(oldButton.getAttribute('aria-pressed'), 'false');
  container.querySelector('[data-rule-result="both-good"]').click();
  assert.equal(container.querySelector('[data-rule-result="both-good"]').getAttribute('aria-pressed'), 'true');
  const nextButton = container.querySelector('[data-rule-result="both-good"]');
  controller.destroy();
  const final = page.window.ReportRules.render(container, page.window.EvaluationReportData);
  page.controllers.add(final);
  nextButton.click();
  assert.equal(nextButton.getAttribute('aria-pressed'), 'true', '重复销毁旧控制器不能丢失当前实例，后续重挂载必须释放当前事件');
});

test('历史提示词快照保留独立版本、完整资源和来源定位，案例版本保持各自的正式记录', t => {
  const page = environment(t);
  const api = page.window.ReportPrompts;
  assert.equal(api.evaluatorVersion, 'r74');
  assert.equal(page.window.EvaluationReportData.meta.evaluator, 'r73');
  const groups = ['criteria', 'attribution', 'comparison', 'clustering', 'rewrite', 'shared', 'tools'];
  assert.deepEqual([...new Set(api.data.map(resource => resource.group))], groups);
  assert.equal(new Set(api.data.map(resource => resource.path)).size, api.data.length);
  for (const resource of api.data) {
    const [group, name] = resource.id.split('/');
    assert.equal(group, resource.group);
    assert.match(name, /^[a-z_]+$/);
    assert.equal(resource.path, `packages/prompts/resources/${group}/${groups.slice(0, 5).includes(group) ? 'default/' : ''}${name}.md`);
    assert.ok(resource.name.trim() && resource.text.trim(), `${resource.id} 保留历史原文和名称`);
  }
});

test('提示词七个入口直接呈现28份完整原文，切换和重新挂载不截断或下载', t => {
  const page = environment(t);
  const api = page.window.ReportPrompts;
  const container = page.document.getElementById('promptsBody');
  const controller = api.render(container);
  page.controllers.add(controller);
  assert.equal(api.data.length, 28);
  assert.equal(new Set(api.data.map(resource => resource.id)).size, 28);
  const tabs = [...container.querySelectorAll('[data-prompt-component]')];
  assert.equal(tabs.length, 7);
  assert.equal(controller.selected, 'criteria');
  assert.ok(container.querySelector('[data-prompt-original="criteria/instructions"]'));
  const visited = new Set();
  for (const tab of tabs) {
    tab.click();
    assert.equal(controller.selected, tab.dataset.promptComponent);
    assert.equal(container.querySelector('.rp-snapshot').textContent, `提示词 ${api.evaluatorVersion}`);
    if (!['shared', 'tools'].includes(controller.selected)) {
      const excerpts = [...container.querySelectorAll('[data-prompt-excerpt]')];
      assert.ok(excerpts.length >= 3, '每个评测组件先呈现可扫读的关键规则');
      for (const excerpt of excerpts) {
        const resource = api.data.find(resource => resource.id === excerpt.dataset.promptExcerpt);
        assert.ok(resource.text.includes(excerpt.textContent), '关键规则必须是对应提示词的连续原文');
        assert.equal(excerpt.tagName, 'DD');
        assert.ok(excerpt.previousElementSibling?.matches('dt'));
      }
      assert.deepEqual([...container.querySelectorAll('.rp-workflow dt')].map(node => node.textContent), ['输入', '执行', '产出']);
      assert.ok(container.querySelector(`[data-prompt-original="${controller.selected}/instructions"] .rp-rule-block`), '长规则正文应有层次，不能只剩全文文本墙');
    }
    for (const body of container.querySelectorAll('[data-prompt-original]')) {
      const resource = api.data.find(resource => resource.id === body.dataset.promptOriginal);
      assert.equal(body.textContent, resource.text, `${resource.id} 包含完整原文、缩进与换行`);
      assert.equal(body.closest('details,[hidden]')?.closest('#promptsBody') || null, null);
      visited.add(resource.id);
    }
  }
  assert.equal(visited.size, 28);
  assert.equal(container.querySelector('[download],details,textarea'), null);
  for (const button of container.querySelectorAll('button')) assert.doesNotMatch(button.textContent, /下载|展开/);
  page.key(tabs.at(-1), 'Home');
  assert.equal(controller.selected, 'criteria');
  assert.equal(page.document.activeElement, tabs[0]);
  const next = api.render(container);
  page.controllers.add(next);
  tabs[2].click();
  assert.equal(next.selected, 'criteria');
  page.key(container.querySelector('[data-prompt-component="criteria"]'), 'ArrowDown');
  assert.equal(next.selected, 'attribution');
});

test('单文件重开完整保留案例、提示词和空实验结构，无外部资源或下载入口', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'evaluation-interaction-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const output = await buildReport({ output: join(temporary, 'report.html') });
  const html = await readFile(output, 'utf8');
  const page = environment(t, html, true);
  const before = JSON.stringify(page.window.EvaluationReportData);
  assert.equal(page.document.querySelectorAll('script').length, 8);
  assert.equal(page.document.querySelectorAll('style').length, 4);
  assert.equal(page.document.querySelector('script[src],link[rel="stylesheet"],iframe,img[src],image[href]'), null);
  assert.equal(page.document.querySelector('[download],#exportHtmlBtn,#downloadPromptsBtn'), null);
  for (const topic of ['flow', 'rules', 'prompts', 'experiments']) {
    page.document.querySelector(`[data-page="${topic}"]`).click();
    assert.equal(page.document.querySelector('.page:not([hidden])').id, `page-${topic}`);
  }
  const experiments = page.document.getElementById('page-experiments');
  assert.deepEqual([...experiments.querySelectorAll('tbody tr')].map(row => row.textContent.trim()), ['—', '—']);
  assert.deepEqual([...experiments.querySelectorAll('.empty-metric')].map(node => node.textContent), ['—', '—', '—']);
  page.document.querySelector('[data-page="flow"]').click();
  page.selectCase(page.window.EvaluationReportData.cases.length - 1);
  page.swap();
  assertMapping(page, page.window.EvaluationReportData.cases.at(-1), true);
  const reopened = environment(t, html, true);
  assert.equal(JSON.stringify(reopened.window.EvaluationReportData), before);
  assert.equal(reopened.document.querySelector('.page:not([hidden])').id, 'page-flow');
  assertMapping(reopened, reopened.window.EvaluationReportData.cases[0]);
  assertCaseContent(reopened, reopened.window.EvaluationReportData.cases[0]);
  assert.equal(JSON.stringify(page.window.EvaluationReportData), before);
});

async function sourceRecord(provenance, identity, predicate) {
  const { file, line: expectedLine } = provenance;
  const stream = createReadStream(join(directory, '..', file), { encoding: 'utf8' });
  let pending = '', lineNumber = 0;
  function matchingRecord(line) {
    lineNumber++;
    if (!line.includes(JSON.stringify(identity))) return null;
    const record = JSON.parse(line);
    if (!predicate(record)) return null;
    assert.equal(lineNumber, expectedLine, `来源记录的 LF 行号必须准确：${file}`);
    return record;
  }
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const record = matchingRecord(line);
        if (record) return record;
      }
    }
    if (pending) {
      const record = matchingRecord(pending);
      if (record) return record;
    }
  } finally { stream.destroy(); }
  assert.fail(`未找到案例来源记录：${file} / ${identity}`);
}

test('本地来源可用时逐案例核对原文、正式判词、匿名映射及真实后处理', async t => {
  const page = environment(t);
  for (const item of page.window.EvaluationReportData.cases) {
    await t.test(item.title, async t => {
      const required = new Set([item.provenance.comparison.file, item.provenance.criteria.file, item.provenance.comparisonTask.state.file]);
      item.candidates.forEach(candidate => { required.add(candidate.provenance.source.file); required.add(candidate.provenance.attribution.file); });
      item.clustering.records.forEach(record => { required.add(record.provenance.clustering.file); required.add(record.provenance.library.file); });
      for (const file of required) {
        try { await access(join(directory, '..', file)); }
        catch (error) { if (error.code === 'ENOENT') { t.skip(`本地核查源未附带：${file}`); return; } throw error; }
      }
      const cache = new Map();
      const json = async file => {
        if (!cache.has(file)) cache.set(file, JSON.parse(await readFile(join(directory, '..', file), 'utf8')));
        return cache.get(file);
      };
      const identity = item.provenance.case;
      const isCase = row => (row.case || row).case_id === identity.case_id && (row.case || row).batch_id === identity.batch_id;
      const comparison = await sourceRecord(item.provenance.comparison, item.provenance.comparisonId, row => row.comparison_id === item.provenance.comparisonId);
      assert.equal(comparison.evaluator_version, item.provenance.evaluatorVersion);
      assert.equal(comparison.status, 'decided');
      assert.equal(comparison.has_standard_answer, item.hasStandardAnswer, '报告题型直接取正式comparison最终标识，不取单条输入是否提供标准');
      assert.equal(comparison.has_standard_answer, comparison.ground_truth.available);
      assert.deepEqual(comparison.ground_truth, plain(item.groundTruth), '标准答案快照与正式比较记录一致');
      assert.equal(comparison.decision_basis.comparisons.length, item.comparisons.length);
      assert.equal(comparison.decision_basis.tradeoff, item.tradeoff);
      assert.equal(atPointer(comparison, item.presentation.decision.provenance.pointer), item.tradeoff, '判决摘要的来源必须是该例正式取舍原文');
      for (const row of item.presentation.matrixRows.filter(row => row.cautionProvenance)) {
        assert.equal(row.cautionProvenance.file, item.provenance.comparison.file);
        const source = atPointer(comparison, row.cautionProvenance.pointer);
        assert.ok(row.comparisonIndices.some(index => JSON.stringify(source) === JSON.stringify(comparison.decision_basis.comparisons[index])), '疑点标注必须指向本行涵盖的原比较');
      }
      item.comparisons.forEach((row, index) => assert.deepEqual(comparison.decision_basis.comparisons[index], plain(row.originals)));
      assert.deepEqual(Object.values(comparison.verdicts)[0], plain(item.verdict));
      const criteria = await sourceRecord(item.provenance.criteria, comparison.criteria_task_id, row => row.task_id === comparison.criteria_task_id);
      assert.equal(['requirements', 'scoring_points', 'red_flags'].reduce((sum, group) => sum + criteria.result[group].length, 0), item.criteria.length);
      for (const rule of item.criteria) {
        const original = atPointer(criteria, rule.provenance.pointer);
        assert.equal(original.id, rule.id);
        assert.ok(original.text === rule.text, `${rule.id} 判据原文必须保持完整`);
        assert.ok(original.acceptance_rule === rule.acceptance_rule, `${rule.id} 验收规则必须保持完整`);
        assert.deepEqual(original.applies_to, plain(rule.applies_to));
      }
      const state = await json(item.provenance.comparisonTask.state.file);
      const task = atPointer(state, item.provenance.comparisonTask.state.pointer);
      assert.deepEqual(task.inputIds, plain(item.provenance.blindMapping));
      const references = [];
      for (const candidate of item.candidates) {
        const input = await sourceRecord(candidate.provenance.source, identity.case_id, isCase);
        // Match the production input contract: false suppresses both metadata fields on this input;
        // a valid reference from another candidate can still be shared by the comparison.
        if (input.has_standard_answer !== false) {
          for (const field of ['ground_truth', 'std_answer']) {
            const value = input.meta[field];
            if (value !== null && value !== undefined && value !== '') references.push(value);
          }
        }
        const questionTexts = [input.meta.question, ...input.messages.filter(message => message.role === 'user').flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content || []).map(part => part.text))];
        assert.ok(questionTexts.includes(item.question), '完整问句应来自输入的题目或用户消息');
        const excerpt = candidate.answerExcerptProvenance;
        assert.deepEqual({file: excerpt.file, line: excerpt.line}, plain(candidate.provenance.source), '回答摘录引用同一份源文件及 LF 行');
        assert.equal(atPointer(input, excerpt.pointer).slice(excerpt.characterStart, excerpt.characterStart + excerpt.characterLength), candidate.answerExcerpt);
        const attribution = await sourceRecord(candidate.provenance.attribution, candidate.provenance.task.taskId, row => row.task_id === candidate.provenance.task.taskId);
        assert.deepEqual(attribution.evaluation.core_assessment, plain(candidate.core));
        assert.equal(attribution.evaluation.summary, candidate.summary);
        assert.equal(attribution.evaluation.findings.length, candidate.findings.length);
        for (const finding of candidate.findings) {
          const original = attribution.evaluation.findings.find(value => value.finding_id === finding.finding_id);
          for (const key of Object.keys(finding)) assert.deepEqual(original[key], plain(finding[key]));
        }
        assert.equal(attribution.evaluator_version, item.provenance.evaluatorVersion);
        assert.equal(task.dependencies[candidate.label], attribution.task_id);
        assert.equal(task.inputIds[candidate.label], attribution.input_id);
      }
      const reference = references[0] ?? null;
      for (const value of references) assert.deepEqual(value, reference, '两个标准答案入口及同题两方的有效值必须一致');
      assert.deepEqual(task.data.reference, reference, '恢复状态采用有效共享标准；显式false的输入不能自行提供标准');
      assert.deepEqual(plain(item.groundTruth), {available: references.length > 0, value: reference}, '题型标签不决定金标是否存在，也不从候选回答或工具结果补造标准');
      if (item.rewrite.records.length) {
        assert.equal(atPointer(comparison, item.rewrite.provenance.originalPointer), item.rewrite.before);
        assert.equal(atPointer(comparison, item.rewrite.provenance.rewritePointer), item.rewrite.after);
      }
      for (const record of item.clustering.records) {
        const cluster = await sourceRecord(record.provenance.clustering, record.provenance.clusteringTask.taskId, row => row.task_id === record.provenance.clusteringTask.taskId);
        const classEntry = atPointer(cluster, record.provenance.clustering.pointer);
        assert.equal(classEntry.label, record.classLabel);
        assert.equal(classEntry.component, record.component);
        assert.ok(cluster.result.assignments.some(assignment => JSON.stringify(assignment) === JSON.stringify(record.assignment)));
        const library = await json(record.provenance.library.file);
        const occurrence = library.occurrences.find(value => value.id === record.occurrenceId);
        assert.ok(occurrence, '本例问题必须有真实入库记录');
        assert.equal(occurrence.finding_id, record.findingId);
        assert.equal(occurrence.input_id, item.candidates.find(candidate => candidate.version === record.version).inputId);
        assert.equal(library.classes[record.classId].label, record.classLabel);
      }
    });
  }
});
