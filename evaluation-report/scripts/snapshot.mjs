// Explicit, offline snapshot updater. Neither the browser nor build.mjs imports this module.
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(moduleDir, '../..');

export async function readJsonLines(file, wantedLines, accept = () => true) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rows = [];
  const last = wantedLines ? Math.max(...wantedLines) : Infinity;
  let line = 0;
  let pending = '';
  const consume = text => {
    line++;
    if (!text.trim() || (wantedLines && !wantedLines.has(line))) return;
    try { const value = JSON.parse(text); if (accept(value)) rows.push({ line, value }); }
    catch { throw new Error(`Invalid JSON at ${file}:${line}`); }
  };
  try {
    // Source line coordinates are LF-delimited. readline also splits isolated CR
    // characters, which would shift these coordinates in existing input files.
    for await (const chunk of stream) {
      pending += chunk;
      let boundary;
      while ((boundary = pending.indexOf('\n')) !== -1) {
        consume(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
        if (line >= last) return rows;
      }
    }
    if (pending.length) consume(pending);
  } finally {
    stream.destroy();
  }
  return rows;
}

export function effectiveReference(raw) {
  assert.ok(raw.has_standard_answer === undefined || typeof raw.has_standard_answer === 'boolean');
  if (raw.has_standard_answer === false) return null;
  const values = ['ground_truth', 'std_answer'].map(key => raw.meta?.[key]).filter(value => value !== undefined && value !== null && value !== '');
  assert.ok(values.every(value => JSON.stringify(value) === JSON.stringify(values[0])), 'Conflicting standards in input');
  return values[0] ?? null;
}

export function extractFinalAnswer(raw, finalIndex) {
  const message = raw.messages?.[finalIndex];
  assert.ok(message, `Missing final message ${finalIndex}`);
  const textParts = [];
  const references = [];
  const base = `/messages/${finalIndex}/content`;
  const addText = (text, pointer) => {
    textParts.push({ text, pointer, characters: text.length });
    for (const match of text.matchAll(/<vis-html\b[^>]*>|!\[[^\]]*\]\([^)]*\)/g)) references.push({ type: 'inline-reference', value: match[0], pointer, renderAsText: true });
  };
  if (typeof message.content === 'string') addText(message.content, base);
  else {
    assert.ok(Array.isArray(message.content), 'Unsupported final message content');
    message.content.forEach((part, index) => {
      if (typeof part.text === 'string') addText(part.text, `${base}/${index}/text`);
      else {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? part.url ?? null;
        references.push({ type: part.type ?? 'non-text', pointer: `${base}/${index}`, value: url?.startsWith('data:') ? null : url, embeddedData: Boolean(url?.startsWith('data:')), renderAsText: true });
      }
    });
  }
  assert.ok(textParts.length, 'Final answer has no text');
  return { finalAnswer: textParts.map(part => part.text).join('\n\n'), textParts, references };
}

function receipt(state, taskId, stateRef) {
  const task = state.tasks[taskId];
  const value = task.receipt;
  return { taskId, stage: task.stage, status: task.status, submissionId: value?.submissionId ?? null, attemptId: value?.attemptId ?? null, evaluatorVersion: value?.evaluatorVersion ?? null, judge: value?.judge ?? null, acceptedAt: value?.acceptedAt ?? null, state: { file: stateRef, pointer: `/tasks/${taskId}` } };
}

// Keep readable source excerpts and coordinates, without copying large evidence messages
// (which can contain an entire system prompt or duplicate a final answer).
export function evidenceCoordinates(value, resultRef, pointer = '') {
  if (Array.isArray(value)) return value.map((item, index) => evidenceCoordinates(item, resultRef, `${pointer}/${index}`));
  if (!value || typeof value !== 'object') return value;
  if (Number.isInteger(value.message_index) && typeof value.quote === 'string') {
    const { quote, ...fields } = value;
    const characters = Array.from(quote);
    const quoteTruncated = characters.length > 1600;
    const quoteExcerpt = quoteTruncated
      ? `${characters.slice(0, 1200).join('')}\n\n[……中间省略 ${characters.length - 1600} 字符……]\n\n${characters.slice(-400).join('')}`
      : quote;
    return { ...fields, quoteExcerpt, quoteTruncated, quoteCharacters: characters.length, provenance: { ...resultRef, pointer: `${pointer}/quote` } };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evidenceCoordinates(item, resultRef, `${pointer}/${key}`)]));
}

async function buildRunSnapshot({ root, runDir, selection, snapshotAt }) {
  root = resolve(root);
  runDir = resolve(root, runDir);
  const rel = file => relative(root, file).split('\\').join('/');
  const sourceRef = (file, line, pointer) => ({ file: rel(file), line, ...(pointer ? { pointer } : {}) });
  const stateFile = resolve(runDir, 'state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const stats = JSON.parse(await readFile(resolve(runDir, 'stats.json'), 'utf8'));
  const selectedIds = new Set(selection.map(item => item.comparisonId));
  const tasks = Object.entries(state.tasks).filter(([, task]) => task.stage === 'comparison' && selectedIds.has(task.data.comparisonId));
  assert.equal(tasks.length, selectedIds.size, 'Every selected comparison must exist');
  const selectedInputs = new Set(tasks.flatMap(([, task]) => Object.values(task.inputIds)));
  const criteriaIds = new Set(tasks.map(([, task]) => task.dependencies.criteria));
  const attributionIds = new Set(tasks.flatMap(([, task]) => Object.keys(task.inputIds).map(key => task.dependencies[key])));
  const resultFiles = Object.fromEntries(['criteria', 'attribution', 'comparison'].map(name => [name, resolve(runDir, `results/${name}.jsonl`)]));
  const records = await Promise.all(Object.values(resultFiles).map(file => readJsonLines(file)));
  const criteriaRows = records[0].filter(row => criteriaIds.has(row.value.task_id));
  const attributionRows = records[1].filter(row => attributionIds.has(row.value.task_id));
  const comparisonRows = records[2].filter(row => selectedIds.has(row.value.comparison_id));
  assert.equal(comparisonRows.length, selectedIds.size, 'Selection requires official accepted results');
  const indexBy = (rows, key) => new Map(rows.map(row => [row.value[key], row]));
  const criteria = indexBy(criteriaRows, 'task_id');
  const attributions = indexBy(attributionRows, 'task_id');
  const comparisons = indexBy(comparisonRows, 'comparison_id');
  assert.equal(attributions.size, attributionRows.length, 'Duplicate attribution task');
  assert.equal(comparisons.size, comparisonRows.length, 'Duplicate comparison');
  const inputConfig = new Map(state.config.inputs.versions.map(version => [version.id, version]));
  const sourceFiles = new Map();
  for (const [id, input] of Object.entries(state.inputs)) {
    if (!selectedInputs.has(id)) continue;
    const file = isAbsolute(input.source) ? input.source : resolve(root, input.source);
    if (!sourceFiles.has(file)) sourceFiles.set(file, new Map());
    assert.ok(input.trace_id, 'Source matching requires a trace ID');
    assert.ok(!sourceFiles.get(file).has(input.trace_id), 'Duplicate selected source trace');
    sourceFiles.get(file).set(input.trace_id, id);
  }
  const rawInputs = new Map();
  // Import files can be reordered after a run. Resolve by trace identity, then
  // verify the case and standard; preserve both current and recorded coordinates.
  for (const [file, ids] of sourceFiles) {
    const rows = await readJsonLines(file, undefined, value => ids.has(value.trace_id));
    assert.equal(rows.length, ids.size, `Missing selected source rows: ${file}`);
    assert.equal(new Set(rows.map(row => row.value.trace_id)).size, ids.size, 'Duplicate source traces');
    for (const { line, value } of rows) {
      const inputId = ids.get(value.trace_id);
      const input = state.inputs[inputId];
      assert.equal(value.case_id, input.case_id);
      assert.equal(value.batch_id, input.batch_id);
      assert.deepEqual(effectiveReference(value), input.reference, `Standard mismatch: ${inputId}`);
      assert.equal(value.meta.question, input.question);
      rawInputs.set(inputId, { raw: value, answer: extractFinalAnswer(value, input.final_index), source: sourceRef(file, line), recordedSource: sourceRef(file, input.line) });
    }
  }
  const caseMap = new Map();
  for (const selected of selection) {
    const task = tasks.find(([, task]) => task.data.comparisonId === selected.comparisonId)[1];
    const inputIds = Object.values(task.inputIds);
    const input = state.inputs[inputIds[0]];
    assert.ok(inputIds.every(id => state.inputs[id].question === input.question), 'Question differs across paired inputs');
    caseMap.set(selected.comparisonId, { title: selected.title, category: selected.category, question: input.question, batchId: input.batch_id, caseId: input.case_id, pairs: [], inputIds });
  }
  const usedComparisons = new Set();
  for (const [taskId, task] of tasks) {
    assert.equal(task.status, 'succeeded', 'Snapshot requires an accepted comparison');
    const item = caseMap.get(task.data.comparisonId);
    const comparison = comparisons.get(task.data.comparisonId);
    const row = comparison;
    const official = comparison.value;
    assert.equal(official.status, 'decided');
    const current = official;
    const resultRef = sourceRef(resultFiles.comparison, row.line);
    const basePointer = '';
    const criteriaRow = criteria.get(task.dependencies.criteria);
    assert.ok(criteriaRow);
    const criteriaRef = sourceRef(resultFiles.criteria, criteriaRow.line);
    const candidateEntries = Object.entries(task.inputIds).sort(([, first], [, second]) => state.inputs[first].version.localeCompare(state.inputs[second].version));
    const versions = candidateEntries.map(([, id]) => state.inputs[id].version);
    const standards = item.inputIds.map(id => state.inputs[id].reference).filter(value => value !== null);
    assert.ok(standards.every(value => JSON.stringify(value) === JSON.stringify(standards[0])), 'Shared standard conflict in input');
    const groundTruth = { available: standards.length > 0, value: standards[0] ?? null };
    assert.deepEqual(official.ground_truth, groundTruth);
    assert.equal(official.has_standard_answer, groundTruth.available);
    usedComparisons.add(official.comparison_id);
    const candidates = candidateEntries.map(([blind, inputId], index) => {
      const input = state.inputs[inputId];
      const source = rawInputs.get(inputId);
      const attributionTaskId = task.dependencies[blind];
      const attributionRow = attributions.get(attributionTaskId);
      assert.ok(attributionRow, `Missing attribution dependency ${attributionTaskId}`);
      const attribution = attributionRow.value;
      assert.equal(attribution.input_id, inputId);
      const evaluation = attribution.evaluation;
      const attributionRef = sourceRef(resultFiles.attribution, attributionRow.line);
      const names = inputConfig.get(input.version);
      const summaryRewrite = evaluation.rewritten?.rewrites.find(value => value.id === 'summary');
      return {
        version: input.version, versionName: names.display_name || names.name, displayName: names.display_name || names.name,
        label: blind, source: `回答${index === 0 ? '①' : '②'}`, model: input.llm,
        inputId, traceId: input.trace_id, finalAnswer: source.answer.finalAnswer,
        finalAnswerScope: '最终消息全部文本块，按原顺序连接；图片与可视化保留引用，不复制二进制或联网加载。',
        finalAnswerParts: source.answer.textParts.map(({ text, ...part }) => ({ ...source.source, ...part })),
        answerReferences: source.answer.references.map(reference => ({ ...reference, provenance: { ...source.source, pointer: reference.pointer } })),
        core: evaluation.core_assessment, summary: evaluation.summary,
        rewrittenSummary: summaryRewrite?.text ?? null, displaySummary: summaryRewrite?.text ?? evaluation.summary,
        isCorrect: evaluation.is_correct, correctnessReason: evaluation.correctness_reason,
        standardConflict: evaluation.standard_conflict === true,
        findings: evidenceCoordinates(evaluation.findings, attributionRef, '/evaluation/findings'),
        criteriaAssessments: evidenceCoordinates(evaluation.criterion_assessments, attributionRef, '/evaluation/criterion_assessments'),
        numericChecks: evidenceCoordinates(evaluation.numeric_checks, attributionRef, '/evaluation/numeric_checks'),
        correctnessEvidence: evidenceCoordinates(evaluation.correctness_evidence, attributionRef, '/evaluation/correctness_evidence'),
        answerTiming: input.answer_timing, evaluatorVersion: attribution.evaluator_version,
        sourceStandard: { explicitHasStandardAnswer: source.raw.has_standard_answer ?? null, groundTruth: source.raw.meta?.ground_truth ?? null, stdAnswer: source.raw.meta?.std_answer ?? null, effectiveReference: effectiveReference(source.raw) },
        provenance: { source: source.source, recordedSource: source.recordedSource, sourceIdentity: { traceId: input.trace_id, caseId: input.case_id, batchId: input.batch_id }, finalAnswer: { ...source.source, pointer: `/messages/${input.final_index}/content` }, attribution: attributionRef, task: receipt(state, attributionTaskId, rel(stateFile)), blindMapping: { file: rel(stateFile), pointer: `/tasks/${taskId}/inputIds/${blind}` }, originalSource: source.raw._source ?? null },
      };
    });
    const allCriteria = ['requirements', 'scoring_points', 'red_flags'].flatMap(group => criteriaRow.value.result[group].map((requirement, index) => {
      const appliesToVersions = requirement.applies_to.map(id => state.inputs[id].version);
      return { ...requirement, scope: requirement.applies_to.length ? 'candidate-specific' : 'shared', group, appliesToVersions, applicableIndices: versions.flatMap((version, index) => !appliesToVersions.length || appliesToVersions.includes(version) ? [index] : []), provenance: { ...criteriaRef, pointer: `/result/${group}/${index}` } };
    }));
    const requirements = allCriteria.filter(criterion => criterion.group === 'requirements');
    const shared = requirements.filter(requirement => requirement.scope === 'shared');
    const comparisonItems = current.decision_basis.comparisons.map((entry, index) => {
      const keys = candidates.map(candidate => candidate.version);
      return { topic: entry.aspect, cells: keys.map(key => entry.assessments[key].summary), importance: entry.importance, criterion_ids: entry.criterion_ids, betterCandidates: entry.better_candidates, betterIndices: entry.better_candidates.map(key => keys.indexOf(key)), statuses: keys.map(key => entry.assessments[key].status), evidenceStatuses: keys.map(key => entry.assessments[key].evidence_status), findingIndices: keys.map(key => entry.assessments[key].finding_indices), originals: entry, provenance: { ...resultRef, pointer: `${basePointer}/decision_basis/comparisons/${index}` } };
    });
    assert.equal(Object.keys(official.verdicts).length, 1, 'Each selected case is one A/B pairing');
    const verdict = Object.values(official.verdicts)[0];
    assert.ok(['win', 'both_good', 'both_bad'].includes(verdict.result));
    const winnerIndex = verdict?.winner_version ? versions.indexOf(verdict.winner_version) : null;
    assert.ok(winnerIndex === null || winnerIndex >= 0);
    const comparisonReceipt = receipt(state, taskId, rel(stateFile));
    const tier = versions[0].endsWith('_fast') ? 'Fast' : 'Expert';
    const rewrite = official?.rewritten?.rewrites.find(value => value.id.endsWith('.reason'));
    const pair = {
      id: task.data.comparisonId, title: `${item.title} · ${tier}`, question: item.question, tier,
      runId: state.runId, evaluatorVersion: row.value.evaluator_version, judge: comparisonReceipt.judge,
      status: 'decided', hasStandardAnswer: groundTruth.available, groundTruth,
      candidates, criteria: allCriteria,
      criteriaSummary: { shared: shared.length, candidateSpecific: requirements.filter(requirement => requirement.scope !== 'shared' && requirement.applicableIndices.length).length },
      comparisons: comparisonItems, outcome: verdict.result, winnerIndex,
      winnerVersion: verdict?.winner_version ?? null, reason: verdict?.reason ?? current.decision_basis.tradeoff,
      rewrittenReason: rewrite?.text ?? null, tradeoff: current.decision_basis.tradeoff,
      verdict, ranking: current.ranking, assessments: current.assessments,
      reviewRequests: [],
      originalDecisionBasis: current.decision_basis,
      provenance: { runId: state.runId, evaluatorVersion: row.value.evaluator_version, comparisonId: task.data.comparisonId, case: { batch_id: item.batchId, case_id: item.caseId }, comparison: resultRef, review: null, result: resultRef, criteria: criteriaRef, comparisonTask: comparisonReceipt, blindMapping: task.inputIds },
      presentation: {
        kind: groundTruth.available ? '客观题' : '主观题',
        checklist: shared.map(requirement => requirement.text),
        checklistProvenance: shared.map(requirement => ({ text: requirement.text, criterionIds: [requirement.id], source: 'criteria', sourceQuote: requirement.text, provenance: requirement.provenance })),
        result: candidates.map(candidate => candidate.core.meets_core === true ? '核心可用' : candidate.core.meets_core === false ? '核心不可用' : '待核实'),
        formula: candidates.map(candidate => groundTruth.available ? candidate.isCorrect === true ? '匹配标准' : candidate.isCorrect === false ? '未匹配标准' : '标准核对未决' : '无标准答案'),
        check: candidates.map(candidate => candidate.core.reason),
        finding: candidates.map(candidate => candidate.displaySummary),
        matrixRows: comparisonItems.map((entry, index) => ({ label: entry.topic, values: entry.cells, comparisonIndex: index, comparisonIndices: [index], provenance: entry.provenance })),
        decision: { summary: current.decision_basis.tradeoff, provenance: { ...resultRef, pointer: `${basePointer}/decision_basis/tradeoff` } },
        reason: verdict?.reason ?? current.decision_basis.tradeoff,
      },
    };
    const caveats = [];
    if (candidates.some(candidate => candidate.standardConflict)) caveats.push('归因记录标记标准答案冲突；保留原标准、核验说明与原判，不将标准视为已获独立验证。');
    if (caveats.length) pair.presentation.decision.caveat = caveats.join('');
    item.pairs.push(pair);
  }
  assert.equal(usedComparisons.size, comparisonRows.length);
  const cases = [...caseMap.values()];
  for (const item of cases) {
    assert.ok(item.pairs.length);
    item.defaultPairId = item.pairs[0].id;
    item.provenance = { runId: state.runId, case: { batch_id: item.batchId, case_id: item.caseId }, inputIds: item.inputIds };
    delete item.inputIds;
  }
  const countVersions = rows => Object.fromEntries([...new Set(rows.map(row => row.value.evaluator_version))].map(version => [version, rows.filter(row => row.value.evaluator_version === version).length]));
  return {
    meta: { runId: state.runId, runStatus: state.status, evaluator: [...new Set(comparisonRows.map(row => row.value.evaluator_version))].join(' / '), evaluatorVersions: countVersions(comparisonRows), configuredEvaluator: state.evaluatorVersion, judgeModels: stats.judge_models, snapshotAt: snapshotAt ?? new Date().toISOString(), startedAt: state.startedAt, finishedAt: state.finishedAt, caseCount: cases.length, pairCount: comparisonRows.length, decidedCount: comparisonRows.length, pendingCount: 0, inputCount: rawInputs.size, attributionCount: attributionRows.length, criteriaCount: criteriaRows.length, standardCaseCount: cases.filter(item => item.pairs[0].hasStandardAnswer).length, stageEvaluators: { criteria: countVersions(criteriaRows), attribution: countVersions(attributionRows), comparison: countVersions(comparisonRows), review: {} }, clusteringEnabled: state.config.clustering.enabled, sourceRun: rel(runDir), sourceValidation: stats.validation, sourceProvenance: { state: rel(stateFile), stats: rel(resolve(runDir, 'stats.json')) } },
    limits: { reviewRounds: 1 }, cases,
  };
}

export async function buildSnapshot({ root = defaultRoot, selectionFile, snapshotAt = new Date().toISOString() } = {}) {
  assert.ok(selectionFile, 'An explicit --selection manifest is required');
  root = resolve(root);
  const selection = JSON.parse(await readFile(resolve(root, selectionFile), 'utf8'));
  assert.equal(selection.cases.length, 60);
  assert.equal(new Set(selection.cases.map(item => item.comparisonId)).size, 60);
  const runs = [];
  for (const run of new Set(selection.cases.map(item => item.run))) {
    runs.push(await buildRunSnapshot({ root, runDir: 'data/runs/comparison/' + run, selection: selection.cases.filter(item => item.run === run), snapshotAt }));
  }
  const byId = new Map(runs.flatMap(run => run.cases).map(item => [item.defaultPairId, item]));
  const cases = selection.cases.map((selected, index) => {
    const item = byId.get(selected.comparisonId), pair = item.pairs[0];
    assert.equal(pair.tier, selected.tier);
    assert.equal(pair.hasStandardAnswer, selected.hasStandardAnswer);
    assert.equal(pair.status, 'decided');
    return { id: 'case-' + String(index + 1).padStart(2, '0'), ...item };
  });
  const pairs = cases.flatMap(item => item.pairs);
  const questionCount = new Set(cases.map(item => item.question.normalize('NFKC').replace(/\s+/gu, '').replace(/[?？。]+$/u, ''))).size;
  assert.equal(questionCount, cases.length, 'Each selected case must be a different question, across tiers and runs');
  assert.equal(new Set(cases.map(item => item.caseId)).size, cases.length, 'A question ID cannot be selected more than once');
  const strata = Object.fromEntries(['Fast', 'Expert'].map(tier => [tier, {
    subjective: pairs.filter(pair => pair.tier === tier && !pair.hasStandardAnswer).length,
    objective: pairs.filter(pair => pair.tier === tier && pair.hasStandardAnswer).length,
  }]));
  assert.deepEqual(strata, { Fast: { subjective: 20, objective: 10 }, Expert: { subjective: 20, objective: 10 } });
  const count = key => runs.reduce((sum, run) => sum + run.meta[key], 0);
  return { meta: {
    snapshotAt, snapshotDate: selection.snapshotDate, selection: { file: relative(root, resolve(root, selectionFile)), unit: selection.unit, rationale: selection.rationale },
    caseCount: cases.length, questionCount,
    pairCount: pairs.length, decidedCount: pairs.length, pendingCount: 0, standardCaseCount: 20, strata,
    inputCount: count('inputCount'), attributionCount: count('attributionCount'), criteriaCount: count('criteriaCount'),
    evaluatorVersions: Object.fromEntries([...new Set(pairs.map(pair => pair.evaluatorVersion))].map(version => [version, pairs.filter(pair => pair.evaluatorVersion === version).length])),
    sources: runs.map(run => run.meta),
  }, limits: { reviewRounds: 1 }, cases };
}

export async function writeSnapshot(snapshot, output) {
  // Escaping '<' keeps answer text such as </script> inert when build.mjs inlines this file.
  const json = JSON.stringify(snapshot, null, 2).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  await writeFile(output, `// 显式离线更新生成；页面与构建不读取原始数据。\nwindow.EvaluationReportData = ${json};\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const selectionFile = option('--selection');
  if (!selectionFile) throw new Error('Usage: node evaluation-report/scripts/snapshot.mjs --selection evaluation-report/src/data/case-selection.json [--output /absolute/data.js]');
  const output = resolve(option('--output') ?? resolve(moduleDir, '../src/data/cases.js'));
  const snapshot = await buildSnapshot({ selectionFile });
  await writeSnapshot(snapshot, output);
  console.log(`Snapshot: ${snapshot.meta.caseCount} cases / ${snapshot.meta.pairCount} pairings (${snapshot.meta.decidedCount} decided, ${snapshot.meta.pendingCount} pending) → ${output}`);
}
