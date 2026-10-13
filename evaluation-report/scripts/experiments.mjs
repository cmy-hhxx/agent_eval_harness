import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { emptyUsage } from '@eval/contracts';
import { readRunTasks, readRunState, writeRunState, createResultWriter, loadRunInputs, bindTask } from '@eval/workflows/comparison';
import { loadConfig, createModelResolver } from '@eval/host-app/config';
import { services } from '@eval/host-app/composition';
import { loadIdentity } from '@eval/runtime/client';
import { runEvaluation } from '@eval/host';
import { extractFinalAnswer, effectiveReference } from './snapshot.mjs';

const root = path.resolve(import.meta.dirname, '../..');
process.chdir(root);
const directory = '.artifacts/report-experiments-20261013';
const protocolFile = `${directory}/protocol.json`;
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = async (file, value) => { await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); };
const host = await loadConfig(['configs/host.json']);
host.models.bindings.comparison.model = 'gpt-6-luna';
const modelForStage = createModelResolver(host.models);
const judge = modelForStage('comparison');
const context = {window: {}};
vm.runInNewContext(await readFile('evaluation-report/src/data/cases.js', 'utf8'), context);
const cases = JSON.parse(JSON.stringify(context.window.EvaluationReportData.cases));

async function prepare() {
  assert.equal(await access(protocolFile).then(() => true, () => false), false, 'Protocol already exists; resume its runs instead');
  assert.equal(cases.length, 60);
  assert.equal(new Set(cases.map(item => item.question.replace(/\s+/g, ''))).size, 60);
  const tasks = new Map(), receipts = {}, catalog = new Map(), originals = new Map();
  for (const runId of new Set(cases.map(item => item.pairs[0].runId))) {
    const source = `data/runs/comparison/${runId}`;
    const checkpoint = await json(`${source}/state.json`);
    const ids = new Set();
    const visit = id => { if (ids.has(id)) return; ids.add(id); Object.values(checkpoint.tasks[id].dependencies).forEach(visit); };
    cases.filter(item => item.pairs[0].runId === runId).forEach(item => visit(item.pairs[0].provenance.comparisonTask.taskId));
    const state = await readRunTasks(source, [...ids]);
    for (const task of state.manifest.tasks.filter(task => ids.has(task.id))) {
      assert.ok(state.receipts[task.id], `Missing accepted source ${task.id}`);
      if (task.stage === 'comparison') originals.set(task.id, task);
      else { assert.ok(['criteria', 'attribution'].includes(task.stage)); tasks.set(task.id, task); receipts[task.id] = state.receipts[task.id]; }
      Object.values(task.inputIds).forEach(id => catalog.set(id, state.manifest.inputCatalog.find(candidate => candidate.input_id === id)));
    }
  }
  const expectedInputs = new Map();
  for (const item of cases) for (const candidate of item.pairs[0].candidates) {
    const saved = catalog.get(candidate.inputId);
    assert.equal(saved.trace_id, candidate.traceId);
    saved.source = path.resolve(candidate.provenance.source.file);
    saved.line = candidate.provenance.source.line;
    expectedInputs.set(candidate.inputId, candidate);
  }
  assert.equal(tasks.size, 180);
  const config = structuredClone(host.evaluation);
  config.rewrite = {comparison: false, attribution: false, clustering: false};
  config.clustering.enabled = false;
  config.execution.concurrency = 8;
  const engine = await loadIdentity('pi', services.runtime.root);
  const protocol = {id: 'report-comparison-stability-20261013', createdAt: new Date().toISOString(),
    comparisonEvaluator: host.evaluatorVersion, judge: judge.model, thinking: judge.thinking,
    engine, execution: config.execution, totalConcurrency: 24,
    scope: '冻结现有60题的标准、归因与输入；仅比较阶段独立重跑三轮；第三轮交换匿名位置；不改写、不追加上游评测。',
    selectionSource: 'evaluation-report/src/data/case-selection.json', runs: [], samples: []};
  protocol.samples = cases.map(item => {
    const pair = item.pairs[0], original = originals.get(pair.provenance.comparisonTask.taskId);
    return {id: pair.id, title: item.title, question: item.question, case: pair.provenance.case,
      tier: pair.tier, hasStandardAnswer: pair.hasStandardAnswer, source: pair.provenance.result,
      sourceRun: pair.runId, sourceTaskId: original.id,
      upstream: Object.entries(original.dependencies).map(([label, id]) => ({label, taskId: id,
        evaluator: receipts[id].evaluatorVersion, judge: receipts[id].judge})),
      inputs: pair.candidates.map(candidate => ({inputId: candidate.inputId, traceId: candidate.traceId,
        source: candidate.provenance.source, recordedSource: candidate.provenance.recordedSource})), rounds: []};
  });
  for (const [index, suffix] of ['original-1', 'original-2', 'swapped'].entries()) {
    const runId = `report-${host.evaluatorVersion}-luna-${suffix}-20261013`;
    const run = {id: runId, label: ['原位一', '原位二', '交换 A/B'][index], path: `${directory}/runs/${runId}`, swapped: index === 2};
    protocol.runs.push(run);
    assert.equal(await access(run.path).then(() => true, () => false), false, 'Run directory already exists');
    const comparisons = cases.map((item, sampleIndex) => {
      const original = originals.get(item.pairs[0].provenance.comparisonTask.taskId);
      const task = structuredClone(original);
      task.id = randomUUID(); task.data.comparisonId = `cmp_${randomUUID()}`;
      if (run.swapped) for (const field of ['inputIds', 'dependencies']) [task[field].A, task[field].B] = [task[field].B, task[field].A];
      task.data.candidates = Object.fromEntries(Object.entries(task.inputIds).map(([label, id]) => [label, catalog.get(id)]));
      protocol.samples[sampleIndex].rounds.push({runId, taskId: task.id, comparisonId: task.data.comparisonId,
        mapping: Object.fromEntries(Object.entries(task.data.candidates).map(([label, candidate]) => [label, candidate.version]))});
      return task;
    });
    const all = [...tasks.values(), ...comparisons];
    const state = {manifest: {format: 'evaluation-run', debug: false, runId, status: 'running', engine,
      evaluatorVersion: host.evaluatorVersion, config, tasks: all, inputCatalog: [...catalog.values()],
      inputs: Object.fromEntries([...catalog.keys()].map(id => [id, {id, name: id}])),
      states: Object.fromEntries(all.map(task => [task.id, {status: receipts[task.id] ? 'succeeded' : 'pending', attempts: 0}])),
      executionScope: comparisons.map(task => task.id), preflight: {comparison_count: 60, frozen_upstream_count: 180}, startedAt: Date.now()},
      receipts: structuredClone(receipts), usage: emptyUsage(), recordedAttempts: 0};
    const inputs = await loadRunInputs(state.manifest, undefined, new Set(state.manifest.executionScope));
    for (const [id, expected] of expectedInputs) {
      const raw = inputs[id];
      assert.equal(raw.trace_id, expected.traceId);
      assert.equal(raw.case_id ?? raw.meta?.case_id, catalog.get(id).case_id);
      assert.equal(raw.meta.question, catalog.get(id).question);
      assert.equal(extractFinalAnswer(raw, catalog.get(id).final_index).finalAnswer, expected.finalAnswer);
      assert.deepEqual(effectiveReference(raw), catalog.get(id).reference);
    }
    for (const task of comparisons) bindTask(task, inputs,
      Object.fromEntries(Object.entries(task.dependencies).map(([label,id]) => [label, state.receipts[id]])), {tasks: all});
    await createResultWriter(run.path, inputs)(state);
    await writeRunState(run.path, state);
    console.log(`Prepared ${run.label}: 60 comparisons, 180 frozen dependencies`);
  }
  await save(protocolFile, protocol);
}

async function run() {
  const protocol = await json(protocolFile);
  assert.equal(host.evaluatorVersion, protocol.comparisonEvaluator, 'Evaluator changed since preparation');
  assert.equal(judge.model, protocol.judge);
  assert.equal(judge.thinking, protocol.thinking);
  const concurrency = (protocol.executionEvents?.at(-1)?.totalConcurrency ?? protocol.totalConcurrency) / protocol.runs.length;
  assert.ok(Number.isInteger(concurrency) && concurrency > 0);
  const results = await Promise.allSettled(protocol.runs.map(async record => {
    const state = await readRunState(record.path);
    const config = state.manifest.config;
    let printed = 0;
    const result = await runEvaluation({...services, runId: record.id, output: {kind: 'directory', path: path.resolve(directory, 'runs')},
      engine: 'pi', evaluatorVersion: protocol.comparisonEvaluator, config, policy: config.execution,
      modelForStage, concurrency,
      resumeStages: (state.manifest.pausedStages ?? []).filter(pause => pause.category === 'interruption' &&
        pause.taskIds.every(id => /exceeded token rate limit/i.test(state.manifest.states[id].reason ?? ''))).map(pause => pause.stage),
      retries: config.execution.retries, retryDelaySeconds: config.execution.retryDelaySeconds,
      failureGuard: config.execution.failureGuard, debug: false,
      plan: {tasks: state.manifest.tasks, inputs: {}, catalog: state.manifest.inputCatalog, summary: state.manifest.preflight},
      onProgress(progress) { if (Date.now() - printed > 15000) { printed = Date.now();
        console.log(JSON.stringify({round: record.label, progress})); } }});
    console.log(JSON.stringify({round: record.label, result}));
  }));
  for (const result of results) if (result.status === 'rejected') console.error(result.reason);
  if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
}

async function snapshot() {
  const protocol = await json(protocolFile);
  const states = await Promise.all(protocol.runs.map(run => readRunState(run.path)));
  const samples = protocol.samples.map(sample => ({...sample, results: sample.rounds.map((round, index) => {
    const state = states[index], receipt = state.receipts[round.taskId], status = state.manifest.states[round.taskId];
    const row = receipt?.exported?.row;
    if (receipt) { assert.equal(receipt.judge, protocol.judge); assert.equal(receipt.evaluatorVersion, protocol.comparisonEvaluator); }
    const verdict = row?.verdicts && Object.values(row.verdicts)[0];
    return {...round, status: receipt?.evaluation.status ?? (['failed', 'timed_out', 'blocked'].includes(status.status) ? 'failed' : 'pending'),
      evaluator: receipt?.evaluatorVersion ?? null, judge: receipt?.judge ?? null,
      outcome: verdict?.result ?? null, winner: verdict?.winner_version ?? null,
      core: Object.fromEntries(Object.entries(receipt?.evaluation.assessments ?? {}).map(([label,value]) => [round.mapping[label], value.meets_core])),
      reason: row?.decision_basis?.tradeoff ?? receipt?.evaluation.decision_basis?.tradeoff ?? status.reason ?? '',
      source: {file: `${protocol.runs[index].path}/results/${receipt?.exported?.file ?? 'comparison.jsonl'}`, comparisonId: round.comparisonId},
      attempts: status.attempts, contentSubmissions: receipt?.submissionStats?.contentSubmissions ?? status.failure?.contentSubmissions ?? 0};
  })}));
  const display = {window: {}};
  vm.runInNewContext(await readFile('evaluation-report/src/pages/experiments/index.js', 'utf8'), display);
  const summary = display.window.ReportExperiments.summarize(samples);
  const analysisSource = 'evaluation-report/src/data/experiment-analysis.json';
  const analyses = await json(analysisSource);
  const differences = samples.filter(sample => sample.results.every(result => result.status === 'decided') &&
    new Set(sample.results.map(result => `${result.outcome}:${result.winner}`)).size > 1);
  assert.deepEqual(Object.keys(analyses).sort(), differences.map(sample => sample.id).sort(), 'Disagreement analysis must match the saved experiment');
  for (const sample of differences) {
    const analysis = analyses[sample.id];
    assert.deepEqual(analysis.roundComparisonIds, sample.results.map(result => result.comparisonId), 'Analysis refers to different rounds');
    sample.analysis = analysis;
    sample.results.forEach((result, index) => {
      const receipt = states[index].receipts[result.taskId], row = receipt.exported.row;
      const comparison = row.decision_basis.comparisons[0];
      result.evidence = {comparison, citedFindings: Object.fromEntries(Object.entries(comparison.assessments).map(([version, assessment]) =>
        [version, assessment.finding_indices.map(findingIndex => ({index: findingIndex, text: row.evaluations[version].findings[findingIndex].text}))]))};
      if (analysis.roundNotes?.[index]) result.evidence.originalTradeoff = receipt.evaluation.decision_basis.tradeoff;
    });
  }
  const data = {...protocol, generatedAt: new Date().toISOString(), protocolSource: protocolFile,
    analysisSource,
    upstreamEvaluators: [...new Set(samples.flatMap(sample => sample.upstream.map(item => item.evaluator)))].sort(),
    ...summary, samples};
  const serialized = JSON.stringify(data, null, 2).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  await writeFile('evaluation-report/src/data/experiments.js', '// 真实比较实验离线快照；仅由 experiments.mjs snapshot 读取已保存结果生成。\nwindow.EvaluationExperimentData = ' + serialized + ';\n');
  console.log(JSON.stringify({coverage: data.coverage, metrics: data.metrics, conclusion: data.conclusion}, null, 2));
}

const command = process.argv[2];
if (command === 'prepare') await prepare();
else if (command === 'run') await run();
else if (command === 'snapshot') await snapshot();
else throw new Error('Usage: node evaluation-report/scripts/experiments.mjs prepare|run|snapshot');
