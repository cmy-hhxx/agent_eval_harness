import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extractFinalAnswer, effectiveReference } from '../scripts/snapshot.mjs';

const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = resolve(directory, '..');
const renderer = await readFile(join(directory, 'src/pages/experiments/index.js'), 'utf8');
const context = {window: {}};
for (const file of ['cases.js', 'experiments.js']) vm.runInNewContext(await readFile(join(directory, 'src/data', file), 'utf8'), context);
vm.runInNewContext(renderer, context);
const snapshot = JSON.parse(JSON.stringify(context.window.EvaluationExperimentData));
const cases = JSON.parse(JSON.stringify(context.window.EvaluationReportData.cases));
const summarize = samples => JSON.parse(JSON.stringify(context.window.ReportExperiments.summarize(samples)));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const jsonl = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);

function page(t, data = snapshot) {
  const errors = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<main></main>', {runScripts: 'outside-only', virtualConsole: console});
  dom.window.eval(renderer);
  const container = dom.window.document.querySelector('main');
  const view = dom.window.ReportExperiments.render(container, data);
  t.after(() => { view.destroy(); dom.window.close(); assert.deepEqual(errors, []); });
  return container;
}
function select(container, selector, value) {
  const element = container.querySelector(selector);
  element.value = value;
  element.dispatchEvent(new container.ownerDocument.defaultView.Event('change', {bubbles: true}));
  assert.equal(container.ownerDocument.activeElement, container.querySelector(selector));
}

test('实验与现有60题一一对应；180场独立ID，三轮使用Luna和当前实验评测器', () => {
  assert.equal(snapshot.samples.length, 60);
  assert.deepEqual(snapshot.samples.map(sample => sample.id), cases.map(item => item.pairs[0].id));
  assert.equal(new Set(snapshot.samples.map(sample => sample.question.replace(/\s+/g, ''))).size, 60);
  assert.equal(snapshot.samples.filter(sample => sample.hasStandardAnswer).length, 20);
  assert.equal(snapshot.samples.filter(sample => sample.tier === 'Fast').length, 30);
  assert.equal(snapshot.judge, 'gpt-6-luna');
  assert.equal(snapshot.comparisonEvaluator, 'r196');
  assert.equal(snapshot.totalConcurrency, 24);
  assert.deepEqual(snapshot.runs.map(run => run.swapped), [false, false, true]);
  const results = snapshot.samples.flatMap(sample => sample.results);
  assert.equal(results.length, 180);
  assert.equal(new Set(results.map(result => result.taskId)).size, 180);
  assert.equal(new Set(results.map(result => result.comparisonId)).size, 180);
  for (const sample of snapshot.samples) {
    const [first, repeat, swapped] = sample.results;
    assert.deepEqual(repeat.mapping, first.mapping);
    assert.deepEqual(swapped.mapping, {A: first.mapping.B, B: first.mapping.A});
    for (const result of sample.results.filter(result => ['decided', 'needs_review'].includes(result.status))) {
      assert.equal(result.judge, snapshot.judge);
      assert.equal(result.evaluator, snapshot.comparisonEvaluator);
      if (result.outcome === 'win') assert.ok(Object.values(result.mapping).includes(result.winner));
      else assert.equal(result.winner, null);
    }
  }
  const summary = summarize(snapshot.samples);
  assert.deepEqual(snapshot.coverage, summary.coverage);
  assert.deepEqual(snapshot.metrics, summary.metrics);
  assert.equal(snapshot.conclusion, summary.conclusion);
});

test('Fast/Expert与主客观联动；表格、覆盖、配对指标和详情只展示当前组合', t => {
  const container = page(t), visited = new Set();
  assert.deepEqual([...container.querySelector('[data-exp-kind]').options].map(option => option.value), ['subjective', 'objective']);
  for (const tier of ['Fast', 'Expert']) for (const kind of ['subjective', 'objective']) {
    select(container, '[data-exp-tier]', tier);
    select(container, '[data-exp-kind]', kind);
    assert.equal(container.querySelector('[data-exp-tier]').value, tier);
    const samples = snapshot.samples.filter(sample => sample.tier === tier && sample.hasStandardAnswer === (kind === 'objective'));
    const summary = summarize(samples);
    const rows = [...container.querySelectorAll('[data-experiment-case]')];
    assert.equal(rows.length, kind === 'objective' ? 10 : 20);
    assert.deepEqual(rows.map(row => row.dataset.experimentCase), samples.map(sample => sample.id));
    rows.forEach(row => visited.add(row.dataset.experimentCase));
    assert.equal(container.querySelectorAll('[data-round-result]').length, samples.length * 3);
    assert.equal(container.querySelectorAll('.exp-reason-list section').length, samples.length);
    assert.match(container.querySelector('.exp-protocol').textContent, new RegExp(`${summary.coverage.decided} / ${summary.coverage.planned} 已决`));
    for (const key of ['repeat', 'swap']) assert.match(container.querySelector(`[data-experiment-metric="${key}"]`).textContent,
      new RegExp(`${summary.metrics[key].agree} / ${summary.metrics[key].paired} 对`));
    assert.equal(container.querySelector('.exp-takeaway strong').textContent, summary.conclusion);
  }
  assert.equal(visited.size, 60);
  assert.match(container.textContent, /稳定不等于正确/);
  assert.match(container.textContent, /目的性选样/);
  assert.match(container.textContent, /不用于报告评测准确率/);
  assert.equal(container.querySelectorAll('script,iframe,link,img[src]').length, 0);
});

test('待核、失败、未完成不进入已决分母；真实赢家还原、Wilson区间与零配对', t => {
  const data = structuredClone(snapshot);
  const samples = data.samples.filter(sample => sample.tier === 'Fast' && !sample.hasStandardAnswer);
  for (const sample of samples) sample.results.forEach(result => Object.assign(result,
    {status: 'decided', outcome: 'win', winner: 'a_fast', core: {a_fast: true, b_fast: true}}));
  samples[0].results[1].outcome = 'both_good'; samples[0].results[1].winner = null;
  samples[1].results[1].status = 'needs_review';
  samples[2].results[1].status = 'failed';
  samples.forEach(sample => { sample.results[2].status = 'pending'; });
  const summary = summarize(samples);
  assert.deepEqual(summary.coverage, {planned: 60, decided: 38, pending: 1, failed: 1, incomplete: 20});
  assert.equal(summary.metrics.repeat.agree, 17);
  assert.equal(summary.metrics.repeat.paired, 18);
  assert.equal(summary.metrics.repeat.missing, 2);
  assert.equal(summary.metrics.swap.paired, 0);
  assert.equal(summary.metrics.swap.interval, null);
  assert.equal(summary.metrics.swap.missing, 20);
  const six = samples.slice(3, 9);
  six[0].results[1].winner = 'b_fast';
  const wilson = summarize(six).metrics.repeat.interval;
  assert.ok(Math.abs(wilson[0] - 0.43649717781353) < 1e-12);
  assert.ok(Math.abs(wilson[1] - 0.969946630251694) < 1e-12);
  const container = page(t, data);
  assert.match(container.querySelector('[data-experiment-metric="swap"]').textContent, /—0 \/ 0 对暂无双边完成结果/);
  assert.match(container.textContent, /待核/);
  assert.match(container.textContent, /失败/);
  assert.match(container.textContent, /未完成/);
  const winner = samples[3];
  winner.results.forEach(result => { result.status = 'decided'; result.outcome = 'win'; result.winner = 'a_fast'; });
  const row = page(t, data).querySelector(`[data-experiment-case="${winner.id}"]`);
  assert.deepEqual([...row.querySelectorAll('[data-round-result]')].map(cell => cell.textContent), ['A组胜', 'A组胜', 'A组胜']);
});

test('分歧单列且随筛选变化；逐轮保留正式取舍，分析与证据分开', async t => {
  const container = page(t);
  const analyses = await json(join(directory, 'src/data/experiment-analysis.json'));
  const different = snapshot.samples.filter(sample => new Set(sample.results.map(result => `${result.outcome}:${result.winner}`)).size > 1);
  assert.equal(different.length, 7);
  assert.deepEqual(Object.keys(analyses).sort(), different.map(sample => sample.id).sort());
  for (const [tier, kind, count] of [['Fast','subjective',6],['Fast','objective',1],['Expert','subjective',0],['Expert','objective',0]]) {
    select(container, '[data-exp-tier]', tier); select(container, '[data-exp-kind]', kind);
    const results = container.querySelector('.exp-table-wrap'), differences = container.querySelector('.exp-differences');
    assert.ok(results.compareDocumentPosition(differences) & container.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(results.closest('details'), null);
    const articles = [...container.querySelectorAll('[data-disagreement-case]')];
    assert.equal(articles.length, count);
    for (const article of articles) {
      assert.equal(article.tagName, 'DETAILS');
      assert.equal(article.open, false);
      article.querySelector(':scope > summary').click();
      assert.equal(article.open, true);
      const sample = different.find(sample => sample.id === article.dataset.disagreementCase);
      assert.equal(sample.tier, tier); assert.equal(sample.hasStandardAnswer, kind === 'objective');
      assert.deepEqual(sample.analysis, analyses[sample.id]);
      assert.deepEqual(sample.analysis.roundComparisonIds, sample.results.map(result => result.comparisonId));
      assert.equal(article.querySelector('.exp-analysis > p').textContent, sample.analysis.explanation);
      for (const [index, round] of [...article.querySelectorAll('[data-disagreement-round]')].entries()) {
        const result = sample.results[index];
        assert.equal(round.querySelector('[data-round-tradeoff]').textContent, result.reason);
        assert.equal(round.querySelector('.exp-round-label strong').textContent, result.outcome === 'both_good' ? '都好' : `${result.winner.startsWith('a_') ? 'A组' : 'B组'}胜`);
        assert.ok(round.querySelector('.exp-source').textContent.includes(result.comparisonId));
        assert.ok(round.querySelector('.exp-source').textContent.includes(result.source.file));
        assert.ok(round.querySelector('.exp-round-evidence').textContent.includes(result.evidence.comparison.aspect));
      }
      article.querySelector(':scope > summary').click();
      assert.equal(article.open, false);
    }
    if (!count) assert.match(container.querySelector('.exp-no-differences').textContent, /没有三轮不一致/);
  }
  assert.match(container.querySelector('.exp-round-guide').textContent, /原位一/);
  assert.match(container.querySelector('.exp-round-guide').textContent, /原位二.*材料与 A\/B 顺序不变，独立再判一次，不读取首判结论/);
});

test('汇总展示60题及四组统计；再次点击或选择筛选后恢复分组', t => {
  const container = page(t);
  select(container, '[data-exp-tier]', 'Expert'); select(container, '[data-exp-kind]', 'objective');
  container.querySelector('[data-exp-overview]').click();
  assert.equal(container.querySelector('[data-exp-overview]').getAttribute('aria-pressed'), 'true');
  assert.equal(container.ownerDocument.activeElement, container.querySelector('[data-exp-overview]'));
  assert.match(container.querySelector('.exp-protocol').textContent, /60 题 × 3 轮.*180 \/ 180 已决/);
  assert.match(container.querySelector('[data-experiment-metric="repeat"]').textContent, /56 \/ 60 对/);
  assert.match(container.querySelector('[data-experiment-metric="swap"]').textContent, /55 \/ 60 对/);
  assert.deepEqual([...container.querySelectorAll('[data-experiment-group]')].map(row => [...row.cells].map(cell => cell.textContent)), [
    ['Fast · 主观','20','16 / 20','16 / 20','6'], ['Fast · 客观','10','10 / 10','9 / 10','1'],
    ['Expert · 主观','20','20 / 20','20 / 20','0'], ['Expert · 客观','10','10 / 10','10 / 10','0'],
  ]);
  assert.equal(container.querySelectorAll('[data-disagreement-case]').length, 7);
  assert.equal(container.querySelectorAll('[data-disagreement-case][open]').length, 0);
  assert.equal(container.querySelector('.exp-table').closest('details'), null);
  assert.equal(container.querySelectorAll('[data-disagreement-round]').length, 21);
  assert.equal(container.querySelector('.exp-takeaway strong').textContent, '53 / 60 题三轮结论一致');
  assert.match(container.querySelector('.exp-analysis-boundary').textContent, /不能把变化直接归因为位置偏差/);
  assert.equal(container.querySelectorAll('.exp-text-note').length, 3);
  assert.match(container.querySelector('.exp-analysis-caution').textContent, /依据需复核/);
  container.querySelector('[data-exp-overview]').click();
  assert.equal(container.querySelector('[data-exp-tier]').value, 'Expert');
  assert.equal(container.querySelector('[data-exp-kind]').value, 'objective');
  assert.equal(container.querySelectorAll('[data-experiment-case]').length, 10);
  container.querySelector('[data-exp-overview]').click();
  select(container, '[data-exp-tier]', 'Fast');
  assert.equal(container.querySelector('[data-exp-overview]').getAttribute('aria-pressed'), 'false');
  assert.equal(container.querySelector('[data-exp-kind]').value, 'objective');
  assert.equal(container.querySelectorAll('[data-disagreement-case]').length, 1);
  assert.deepEqual([...container.querySelector('[data-exp-kind]').options].map(option => option.value), ['subjective','objective']);
});

test('报告分析与正式取舍按文本展示，不执行其中的HTML', t => {
  const data = structuredClone(snapshot), sample = data.samples.find(sample => sample.analysis);
  const text = '<img src=x onerror="alert(1)">';
  sample.analysis.explanation = text; sample.results[0].reason = text;
  const container = page(t, data), article = container.querySelector(`[data-disagreement-case="${sample.id}"]`);
  assert.equal(article.querySelector('.exp-analysis > p').textContent, text);
  assert.equal(article.querySelector('[data-round-tradeoff]').textContent, text);
  assert.equal(article.querySelectorAll('img,script,iframe').length, 0);
});

test('本地实验收据与快照一致；上游材料逐条冻结，原位相同、换位只改匿名位置', async t => {
  try { await access(join(repository, snapshot.protocolSource)); }
  catch { t.skip('本机无实验运行来源；离线快照仍可独立验证'); return; }
  const {readRunTasks, loadRunInputs} = await import('@eval/workflows/comparison');
  const protocol = await json(join(repository, snapshot.protocolSource));
  const states = await Promise.all(protocol.runs.map(run => readRunTasks(join(repository, run.path), [])));
  const checkpoints = await Promise.all(protocol.runs.map(run => json(join(repository, run.path, 'state.json'))));
  const inputs = await loadRunInputs(states[0].manifest, undefined, new Set(states[0].manifest.executionScope));
  for (const item of cases) for (const candidate of item.pairs[0].candidates) {
    const raw = inputs[candidate.inputId];
    const registered = states[0].manifest.inputCatalog.find(input => input.input_id === candidate.inputId);
    assert.equal(raw.trace_id, candidate.traceId);
    assert.equal(raw.case_id, item.caseId);
    assert.equal(raw.meta.question, item.question);
    assert.equal(extractFinalAnswer(raw, registered.final_index).finalAnswer, candidate.finalAnswer);
    assert.deepEqual(effectiveReference(raw), registered.reference);
  }
  for (const sourceRun of new Set(snapshot.samples.map(sample => sample.sourceRun))) {
    const samples = snapshot.samples.filter(sample => sample.sourceRun === sourceRun);
    const deps = [...new Set(samples.flatMap(sample => sample.upstream.map(upstream => upstream.taskId)))];
    const source = await readRunTasks(join(repository, 'data/runs/comparison', sourceRun), deps);
    for (const run of protocol.runs) {
      const state = await readRunTasks(join(repository, run.path), deps);
      for (const id of deps) {
        assert.deepEqual(state.receipts[id].evaluation, source.receipts[id].evaluation);
        assert.equal(state.receipts[id].submissionId, source.receipts[id].submissionId);
        assert.equal(state.receipts[id].evaluatorVersion, source.receipts[id].evaluatorVersion);
      }
    }
  }
  for (const sample of snapshot.samples) {
    const tasks = sample.results.map((result, index) => states[index].manifest.tasks.find(task => task.id === result.taskId));
    const strip = task => { const copy = structuredClone(task); delete copy.id; delete copy.data.comparisonId; return copy; };
    assert.deepEqual(strip(tasks[0]), strip(tasks[1]));
    const swap = structuredClone(tasks[2]);
    for (const field of ['inputIds', 'dependencies']) [swap[field].A, swap[field].B] = [swap[field].B, swap[field].A];
    [swap.data.candidates.A, swap.data.candidates.B] = [swap.data.candidates.B, swap.data.candidates.A];
    assert.deepEqual(strip(tasks[0]), strip(swap));
    sample.results.forEach((result, index) => {
      const receipt = checkpoints[index].tasks[result.taskId].receipt;
      if (receipt) { assert.equal(receipt.judge, result.judge); assert.equal(receipt.evaluatorVersion, result.evaluator); }
      assert.ok(checkpoints[index].executionScope.includes(result.taskId));
    });
  }
  for (const [index, run] of protocol.runs.entries()) {
    const rows = await jsonl(join(repository, run.path, 'results/comparison.jsonl'));
    for (const sample of snapshot.samples) {
      const result = sample.results[index];
      const row = rows.find(row => row.comparison_id === result.comparisonId);
      if (result.status !== 'decided') { assert.equal(row, undefined); continue; }
      const verdict = Object.values(row.verdicts)[0];
      assert.equal(verdict.result, result.outcome);
      assert.equal(verdict.winner_version, result.winner);
      assert.equal(row.evaluator_version, snapshot.comparisonEvaluator);
      assert.equal(result.reason, row.decision_basis.tradeoff);
      if (result.evidence) {
        assert.deepEqual(result.evidence.comparison, row.decision_basis.comparisons[0]);
        for (const [version, findings] of Object.entries(result.evidence.citedFindings)) for (const finding of findings)
          assert.equal(finding.text, row.evaluations[version].findings[finding.index].text);
        if (result.evidence.originalTradeoff) {
          const source = await readRunTasks(join(repository, run.path), [result.taskId]);
          assert.equal(result.evidence.originalTradeoff, source.receipts[result.taskId].evaluation.decision_basis.tradeoff);
        }
      }
    }
  }
});
