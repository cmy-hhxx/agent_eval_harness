import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '..');
const [dataSource, renderer] = await Promise.all([
  readFile(join(directory, 'src/experiment-data.js'), 'utf8'),
  readFile(join(directory, 'src/experiments.js'), 'utf8'),
]);
const scope = {window: {}};
vm.runInNewContext(dataSource, scope);
const snapshot = JSON.parse(JSON.stringify(scope.window.EvaluationExperimentData));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const jsonl = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);

function page(t, data = snapshot) {
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<main id="experiments"></main>', {runScripts: 'outside-only', virtualConsole: console});
  dom.window.eval(renderer);
  const container = dom.window.document.querySelector('main');
  dom.window.ReportExperiments.render(container, data);
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  return container;
}

test('真实实验固定六题三轮，按结果类型和稳定模型赢家核对5/6一致及小样本区间', () => {
  assert.equal(snapshot.samples.length, 6);
  assert.equal(new Set(snapshot.samples.map(sample => `${sample.case.batch_id}/${sample.case.case_id}`)).size, 6);
  assert.deepEqual(snapshot.runs.map(run => run.swapped), [false, false, true]);
  assert.equal(snapshot.samples.filter(sample => sample.hasStandardAnswer).length, 3);
  assert.equal(snapshot.samples.filter(sample => sample.tier === 'Fast').length, 3);
  assert.deepEqual(snapshot.coverage, {planned: 18, decided: 18, pending: 0, failed: 0, incomplete: 0});
  const comparisons = snapshot.samples.flatMap(sample => sample.results);
  assert.equal(comparisons.length, 18);
  assert.equal(new Set(comparisons.map(result => result.comparisonId)).size, 18);
  assert.equal(new Set(comparisons.map(result => result.taskId)).size, 18);
  assert.ok(comparisons.every(result => result.evaluator === 'r153' && result.judge === 'MiniMax-M3'));
  assert.deepEqual(snapshot.upstreamEvaluators, ['r151', 'r152']);
  for (const sample of snapshot.samples) {
    const [first, repeat, swapped] = sample.results;
    assert.deepEqual(repeat.mapping, first.mapping);
    assert.deepEqual(swapped.mapping, {A: first.mapping.B, B: first.mapping.A});
    for (const result of sample.results) {
      assert.equal(result.status, 'decided');
      if (result.outcome === 'win') assert.ok(Object.values(result.mapping).includes(result.winner));
      else assert.equal(result.winner, null);
    }
  }
  for (const [name, round] of [['repeat', 1], ['swap', 2]]) {
    const pairs = snapshot.samples.filter(sample => sample.results[0].status === 'decided' && sample.results[round].status === 'decided');
    const disagreements = pairs.filter(sample => {
      const [left, right] = [sample.results[0], sample.results[round]];
      return left.outcome !== right.outcome || left.winner !== right.winner;
    });
    assert.equal(pairs.length, 6);
    assert.deepEqual(disagreements.map(sample => sample.title), ['中谷物流毛利率']);
    assert.equal(snapshot.metrics[name].paired, pairs.length);
    assert.equal(snapshot.metrics[name].agree, pairs.length - disagreements.length);
    assert.equal(snapshot.metrics[name].missing, 0);
    assert.deepEqual(snapshot.metrics[name].disagreements, disagreements.map(sample => sample.id));
    // Wilson 95% score interval for five successes among six independent case pairs.
    assert.ok(Math.abs(snapshot.metrics[name].interval[0] - 0.43649717781353) < 1e-12);
    assert.ok(Math.abs(snapshot.metrics[name].interval[1] - 0.969946630251694) < 1e-12);
  }
  assert.deepEqual(snapshot.samples[0].results.map(result => [result.outcome, result.winner]), [['win', 'a_fast'], ['both_good', null], ['both_good', null]]);
});

test('实验页直接展示18个真实结果，真实赢家不随匿名A/B位置改变，方法与边界可读', t => {
  const container = page(t);
  assert.equal(container.querySelectorAll('[data-experiment-case]').length, 6);
  assert.equal(container.querySelectorAll('[data-round-result]').length, 18);
  const metrics = [...container.querySelectorAll('[data-experiment-metric]')];
  assert.deepEqual(metrics.map(node => node.querySelector('.exp-score strong').textContent), ['83.3%', '83.3%']);
  metrics.forEach(node => {
    assert.match(node.textContent, /5 \/ 6 对/);
    assert.match(node.textContent, /95% 区间 43\.6%–97%/);
    assert.match(node.textContent, /缺失 0 对/);
  });
  const shareholder = snapshot.samples.find(sample => sample.title === '同花顺股东增减持');
  assert.ok(shareholder.results.every(result => result.winner === 'a_fast'));
  const anonymousWinners = shareholder.results.map(result => Object.keys(result.mapping).find(label => result.mapping[label] === result.winner));
  assert.notEqual(anonymousWinners[0], anonymousWinners[2]);
  const row = [...container.querySelectorAll('[data-experiment-case]')].find(node => node.dataset.experimentCase === shareholder.id);
  assert.deepEqual([...row.querySelectorAll('[data-round-result]')].map(node => node.textContent), ['A组胜', 'A组胜', 'A组胜']);
  assert.equal(container.querySelectorAll('.exp-disagreement').length, 1);
  assert.equal(container.querySelector('.exp-disagreement').dataset.experimentCase, snapshot.samples[0].id);
  assert.match(container.querySelector('.exp-protocol').textContent, /冻结标准与归因只重跑比较/);
  assert.match(container.querySelector('.exp-boundaries').textContent, /比较 r153/);
  assert.match(container.querySelector('.exp-boundaries').textContent, /标准 \/ 归因 r151 \/ r152/);
  assert.match(container.querySelector('.exp-boundaries').textContent, /提示词消融 未开展/);
  assert.match(container.querySelector('.exp-boundaries').textContent, /人工一致性 无审定样本/);
  assert.match(container.querySelector('.exp-method-body').textContent, /目的性选样/);
  assert.match(container.querySelector('.exp-method-body').textContent, /未控制模型采样随机性/);
  assert.match(container.querySelector('.exp-method-body').textContent, /不用于报告评测准确率/);
  assert.match(container.querySelector('.exp-takeaway').textContent, /同位重复也有变化，不能单独归因于位置/);
  assert.equal(container.querySelectorAll('script,iframe,link,img[src]').length, 0);
});

test('缺失、待核和失败单列，不充当平局或进入双边已决分母；零配对不报百分比', t => {
  const data = structuredClone(snapshot);
  data.samples[1].results[1] = {...data.samples[1].results[1], status: 'needs_review', outcome: null, winner: null};
  data.samples[2].results[1] = {...data.samples[2].results[1], status: 'failed', outcome: null, winner: null};
  data.samples.forEach(sample => { sample.results[2] = {...sample.results[2], status: 'pending', outcome: null, winner: null}; });
  data.coverage = {planned: 18, decided: 10, pending: 1, failed: 1, incomplete: 6};
  data.metrics.repeat = {...data.metrics.repeat, agree: 3, paired: 4, missing: 2, interval: [0.300641842582402, 0.9544127391903]};
  data.metrics.swap = {...data.metrics.swap, agree: 0, paired: 0, missing: 6, interval: null};
  data.conclusion = '当前结果未全部完成。';
  const container = page(t, data);
  const repeat = container.querySelector('[data-experiment-metric="repeat"]');
  const swap = container.querySelector('[data-experiment-metric="swap"]');
  assert.equal(repeat.querySelector('.exp-score strong').textContent, '75%');
  assert.match(repeat.textContent, /3 \/ 4 对/);
  assert.match(repeat.textContent, /缺失 2 对/);
  assert.equal(swap.querySelector('.exp-score strong').textContent, '—');
  assert.match(swap.textContent, /0 \/ 0 对/);
  assert.match(swap.textContent, /暂无双边完成结果/);
  assert.match(swap.textContent, /缺失 6 对/);
  assert.doesNotMatch(swap.textContent, /NaN|100%|95% 区间/);
  assert.match(container.querySelector('.exp-protocol').textContent, /10 \/ 18 已决1 待核 · 1 失败 · 6 未完成/);
  const statuses = [...container.querySelectorAll('[data-round-result]')].map(node => node.textContent);
  assert.equal(statuses.filter(value => value === '待核').length, 1);
  assert.equal(statuses.filter(value => value === '失败').length, 1);
  assert.equal(statuses.filter(value => value === '未完成').length, 6);
  assert.equal(container.querySelectorAll('.exp-disagreement').length, 0, '尚无三轮完整结果，不能将缺失标为判决分歧');
});

test('本地实验来源可用时核对协议、三轮正式判词、真实映射和完全冻结的上游结果', async t => {
  const protocolFile = resolve(repository, snapshot.protocolSource);
  const required = [protocolFile, ...snapshot.runs.flatMap(run => ['state.json', 'results/comparison.jsonl', 'results/criteria.jsonl', 'results/attribution.jsonl'].map(file => resolve(repository, run.path, file)))];
  for (const file of required) {
    try { await access(file); }
    catch (error) { if (error.code === 'ENOENT') { t.skip(`离线副本未附带本地实验来源：${file}`); return; } throw error; }
  }
  const protocol = await json(protocolFile);
  assert.equal(protocol.plannedCalls, 18);
  assert.equal(protocol.repetitions, 3);
  assert.equal(protocol.comparisonEvaluator, snapshot.comparisonEvaluator);
  assert.equal(protocol.judge, 'MiniMax-M3');
  const sourceResults = {};
  for (const stage of ['criteria', 'attribution']) sourceResults[stage] = await jsonl(join(protocol.sourceRun, 'results', `${stage}.jsonl`));
  const executions = [];
  for (const [round, run] of snapshot.runs.entries()) {
    const state = await json(resolve(repository, run.path, 'state.json'));
    const comparisons = await jsonl(resolve(repository, run.path, 'results/comparison.jsonl'));
    assert.equal(state.runId, run.id);
    assert.equal(state.status, 'finished');
    assert.equal(comparisons.length, 6);
    assert.equal(Object.keys(state.tasks).length, 24);
    assert.equal(state.executionScope.length, 6);
    assert.deepEqual(state.config.rewrite, {comparison: false, attribution: false, clustering: false});
    executions.push(state.config.execution);
    for (const stage of ['criteria', 'attribution']) {
      const frozen = await jsonl(resolve(repository, run.path, 'results', `${stage}.jsonl`));
      assert.equal(frozen.length, stage === 'criteria' ? 6 : 12);
      for (const row of frozen) assert.deepEqual(row, sourceResults[stage].find(source => source.task_id === row.task_id), '实验只复制选中依赖的原结果，不改写标准或归因');
    }
    for (const sample of snapshot.samples) {
      const expected = sample.results[round];
      const source = comparisons.find(row => row.comparison_id === expected.comparisonId);
      assert.ok(source);
      const task = state.tasks[expected.taskId];
      assert.equal(task.receipt.evaluatorVersion, 'r153');
      assert.equal(task.receipt.judge, 'MiniMax-M3');
      assert.equal(task.receipt.exported.comparisonId, expected.comparisonId);
      assert.deepEqual(Object.fromEntries(Object.entries(task.inputIds).map(([label,id]) => [label,state.inputs[id].version])), expected.mapping);
      assert.deepEqual(source.case, sample.case);
      assert.equal(source.has_standard_answer, sample.hasStandardAnswer);
      const verdict = Object.values(source.verdicts)[0];
      assert.equal(verdict.result, expected.outcome);
      assert.equal(verdict.winner_version, expected.winner);
      assert.equal(source.decision_basis.tradeoff, expected.reason);
      assert.deepEqual(Object.fromEntries(Object.entries(source.assessments).map(([version,value]) => [version,value.meets_core])), expected.core);
      for (const upstream of sample.upstream) assert.equal(state.tasks[upstream.taskId].receipt.evaluatorVersion, upstream.evaluator);
      const declared = protocol.runs[round].tasks.find(item => item.taskId === expected.taskId);
      assert.equal(declared.sourceComparisonId, sample.id);
      assert.deepEqual(declared.mapping, expected.mapping);
    }
  }
  assert.deepEqual(executions[1], executions[0]);
  assert.deepEqual(executions[2], executions[0], '工具、超时、修复和并发预算在三轮完全相同');
});
