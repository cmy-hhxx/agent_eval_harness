// Explicit, offline snapshot updater. Neither the browser nor build.mjs imports this module.
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(moduleDir, '../..');
const titles = {
  '市场热点与异动归因_20题_20260921_Q018': '爱柯迪上涨归因',
  '公司事件与财报解读_20题_20260921_Q012': '中谷物流毛利率',
  '公司事件与财报解读_20题_20260921_Q018': '华润电力利润下跌',
  '行业与产业链分析_20题_20260921_Q007': '科技消费量价筛选',
  'apd_questions_117_20260922_6-A-3': '中仑转债转股期',
  '基本面与估值分析_20题_20260922_基本面与估值分析_15': '中国中冶数字化估值',
  'apd_questions_117_20260922_8-P-1': '纯碱玻璃跨品种套利',
  'ground_truth_100_20260923_gt_051': '权益基金成立数量',
  '客观题2500条补充_带标准答案_with_gt_客观题_00169': '同花顺股东增减持',
  '客观题2500条补充_带标准答案_with_gt_客观题_00227': '万科发行价格与数量',
  '客观题2500条补充_带标准答案_with_gt_客观题_00547': '年度涨跌幅前十',
  '客观题2500条补充_带标准答案_with_gt_客观题_01089': 'ETF跟踪指数ROE',
  'case_0924_case_0924_457': '三家电子公司投资比较',
  '客观题2500条补充_带标准答案_with_gt_客观题_01415': '泡泡玛特历史行情',
  '客观题2500条补充_带标准答案_with_gt_客观题_01536': 'QDII基金区间涨跌幅',
  '客观题2500条补充_带标准答案_with_gt_客观题_01750': 'KDJ金叉后连续下跌',
  '客观题2500条补充_带标准答案_with_gt_客观题_01845': '四连阳高价股筛选',
  '线上问句0922-0923清洗6600条_线上问句_04461': 'AI手机板材公司',
  '线上问句0922-0923清洗6600条_线上问句_04738': '广西能源异动归因',
  '线上问句0922-0923清洗6600条_线上问句_04757': '洛阳钼业下跌归因',
  '线上问句0922-0923清洗6600条_线上问句_04829': '长芯博创与AI算力',
  '线上问句0922-0923清洗6600条_线上问句_00068': '场内ETF趋势筛选',
  '线上问句0922-0923清洗6600条_线上问句_00188': '歌尔股份加仓判断',
  '线上问句0922-0923清洗6600条_线上问句_00626': '小阳吸筹回踩公式',
  '客观题2500条补充_带标准答案_with_gt_客观题_00455': '回补跳空缺口股票',
  '客观题2500条补充_带标准答案_with_gt_客观题_00813': '日本居民消费价格指数',
  '客观题2500条补充_带标准答案_with_gt_客观题_00941': '中证2000与上证50',
  'case_0924_case_0924_286': '主力净量阴线筛选',
  '客观题2500条补充_带标准答案_with_gt_客观题_02211': '比亚迪销量与股价',
  '客观题2500条补充_带标准答案_with_gt_客观题_02341': '高增长回购增持筛选',
};

export async function readJsonLines(file, wantedLines) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rows = [];
  const last = wantedLines ? Math.max(...wantedLines) : Infinity;
  let line = 0;
  let pending = '';
  const consume = text => {
    line++;
    if (!text.trim() || (wantedLines && !wantedLines.has(line))) return;
    try { rows.push({ line, value: JSON.parse(text) }); }
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

export async function buildSnapshot({ root = defaultRoot, runDir, snapshotAt } = {}) {
  assert.ok(runDir, 'An explicit --run directory is required');
  root = resolve(root);
  runDir = resolve(root, runDir);
  const rel = file => relative(root, file).split('\\').join('/');
  const sourceRef = (file, line, pointer) => ({ file: rel(file), line, ...(pointer ? { pointer } : {}) });
  const stateFile = resolve(runDir, 'state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const stats = JSON.parse(await readFile(resolve(runDir, 'stats.json'), 'utf8'));
  const resultFiles = Object.fromEntries(['criteria', 'attribution', 'comparison', 'comparison-review'].map(name => [name, resolve(runDir, `results/${name}.jsonl`)]));
  const [criteriaRows, attributionRows, comparisonRows, reviewRows] = await Promise.all(Object.values(resultFiles).map(file => readJsonLines(file)));
  const indexBy = (rows, key) => new Map(rows.map(row => [row.value[key], row]));
  const criteria = indexBy(criteriaRows, 'task_id');
  const attributions = indexBy(attributionRows, 'task_id');
  const comparisons = indexBy(comparisonRows, 'comparison_id');
  const reviews = indexBy(reviewRows, 'task_id');
  assert.equal(attributions.size, attributionRows.length, 'Duplicate attribution task');
  assert.equal(comparisons.size, comparisonRows.length, 'Duplicate comparison');
  const inputConfig = new Map(state.config.inputs.versions.map(version => [version.id, version]));
  const sourceFiles = new Map();
  for (const [id, input] of Object.entries(state.inputs)) {
    const file = isAbsolute(input.source) ? input.source : resolve(root, input.source);
    if (!sourceFiles.has(file)) sourceFiles.set(file, new Map());
    assert.ok(!sourceFiles.get(file).has(input.line), 'Two inputs point to the same source row');
    sourceFiles.get(file).set(input.line, id);
  }
  const rawInputs = new Map();
  // Stream selected physical lines; individual input files may exceed V8 string limits.
  for (const [file, ids] of sourceFiles) {
    const rows = await readJsonLines(file, new Set(ids.keys()));
    assert.equal(rows.length, ids.size, `Missing selected source rows: ${file}`);
    for (const { line, value } of rows) {
      const inputId = ids.get(line);
      const input = state.inputs[inputId];
      assert.equal(value.case_id, input.case_id);
      assert.equal(value.batch_id, input.batch_id);
      assert.deepEqual(effectiveReference(value), input.reference, `Standard mismatch: ${inputId}`);
      rawInputs.set(inputId, { raw: value, answer: extractFinalAnswer(value, input.final_index), source: sourceRef(file, line) });
    }
  }
  const caseMap = new Map();
  for (const [inputId, input] of Object.entries(state.inputs)) {
    const key = JSON.stringify([input.batch_id, input.case_id]);
    if (!caseMap.has(key)) caseMap.set(key, { id: `case-${String(caseMap.size + 1).padStart(2, '0')}`, title: titles[input.case_id] ?? input.question, question: input.question, batchId: input.batch_id, caseId: input.case_id, pairs: [], inputIds: [] });
    const item = caseMap.get(key);
    assert.equal(item.question, input.question, 'Question differs across paired inputs');
    item.inputIds.push(inputId);
  }
  const usedComparisons = new Set();
  const usedReviews = new Set();
  for (const [taskId, task] of Object.entries(state.tasks)) {
    if (task.stage !== 'comparison') continue;
    assert.equal(task.status, 'succeeded', 'Snapshot requires accepted comparison or review result');
    const firstInput = state.inputs[Object.values(task.inputIds)[0]];
    const item = caseMap.get(JSON.stringify([firstInput.batch_id, firstInput.case_id]));
    const review = reviews.get(taskId);
    const comparison = comparisons.get(task.data.comparisonId);
    assert.ok(Boolean(review) !== Boolean(comparison), 'Pair must have exactly one official or review result');
    const row = review ?? comparison;
    const official = comparison?.value;
    const current = review ? review.value.result : official;
    const resultRef = sourceRef(resultFiles[review ? 'comparison-review' : 'comparison'], row.line);
    const basePointer = review ? '/result' : '';
    const criteriaRow = criteria.get(task.dependencies.criteria);
    assert.ok(criteriaRow);
    const criteriaRef = sourceRef(resultFiles.criteria, criteriaRow.line);
    const candidateEntries = Object.entries(task.inputIds).sort(([, first], [, second]) => state.inputs[first].version.localeCompare(state.inputs[second].version));
    const versions = candidateEntries.map(([, id]) => state.inputs[id].version);
    const standards = item.inputIds.map(id => state.inputs[id].reference).filter(value => value !== null);
    assert.ok(standards.every(value => JSON.stringify(value) === JSON.stringify(standards[0])), 'Shared standard conflict in input');
    const groundTruth = { available: standards.length > 0, value: standards[0] ?? null };
    if (official) {
      assert.deepEqual(official.ground_truth, groundTruth);
      assert.equal(official.has_standard_answer, groundTruth.available);
      usedComparisons.add(official.comparison_id);
    } else usedReviews.add(taskId);
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
        provenance: { source: source.source, finalAnswer: { ...source.source, pointer: `/messages/${input.final_index}/content` }, attribution: attributionRef, task: receipt(state, attributionTaskId, rel(stateFile)), blindMapping: { file: rel(stateFile), pointer: `/tasks/${taskId}/inputIds/${blind}` }, originalSource: source.raw._source ?? null },
      };
    });
    const allCriteria = ['requirements', 'scoring_points', 'red_flags'].flatMap(group => criteriaRow.value.result[group].map((requirement, index) => {
      const appliesToVersions = requirement.applies_to.map(id => state.inputs[id].version);
      return { ...requirement, scope: requirement.applies_to.length ? 'candidate-specific' : 'shared', group, appliesToVersions, applicableIndices: versions.flatMap((version, index) => !appliesToVersions.length || appliesToVersions.includes(version) ? [index] : []), provenance: { ...criteriaRef, pointer: `/result/${group}/${index}` } };
    }));
    const requirements = allCriteria.filter(criterion => criterion.group === 'requirements');
    const shared = requirements.filter(requirement => requirement.scope === 'shared');
    const comparisonItems = current.decision_basis.comparisons.map((entry, index) => {
      const keys = candidates.map(candidate => review ? candidate.label : candidate.version);
      return { topic: entry.aspect, cells: keys.map(key => entry.assessments[key].summary), importance: entry.importance, criterion_ids: entry.criterion_ids, betterCandidates: entry.better_candidates, betterIndices: entry.better_candidates.map(key => keys.indexOf(key)), statuses: keys.map(key => entry.assessments[key].status), evidenceStatuses: keys.map(key => entry.assessments[key].evidence_status), findingIndices: keys.map(key => entry.assessments[key].finding_indices), originals: entry, provenance: { ...resultRef, pointer: `${basePointer}/decision_basis/comparisons/${index}` } };
    });
    const verdict = official ? Object.values(official.verdicts)[0] : null;
    const winnerIndex = verdict?.winner_version ? versions.indexOf(verdict.winner_version) : null;
    assert.ok(winnerIndex === null || winnerIndex >= 0);
    const comparisonReceipt = receipt(state, taskId, rel(stateFile));
    const tier = versions[0].endsWith('_fast') ? 'Fast' : 'Expert';
    const rewrite = official?.rewritten?.rewrites.find(value => value.id.endsWith('.reason'));
    const pair = {
      id: task.data.comparisonId, title: `${item.title} · ${tier}`, question: item.question, tier,
      runId: state.runId, evaluatorVersion: row.value.evaluator_version, judge: comparisonReceipt.judge,
      status: review ? 'needs_review' : 'decided', hasStandardAnswer: groundTruth.available, groundTruth,
      candidates, criteria: allCriteria,
      criteriaSummary: { shared: shared.length, candidateSpecific: requirements.filter(requirement => requirement.scope !== 'shared' && requirement.applicableIndices.length).length },
      comparisons: comparisonItems, outcome: verdict?.result ?? 'needs_review', winnerIndex,
      winnerVersion: verdict?.winner_version ?? null, reason: verdict?.reason ?? current.decision_basis.tradeoff,
      rewrittenReason: rewrite?.text ?? null, tradeoff: current.decision_basis.tradeoff,
      verdict, ranking: current.ranking, assessments: current.assessments,
      reviewRequests: review ? current.review_requests : [],
      originalDecisionBasis: current.decision_basis,
      provenance: { runId: state.runId, evaluatorVersion: row.value.evaluator_version, comparisonId: task.data.comparisonId, case: { batch_id: item.batchId, case_id: item.caseId }, comparison: review ? null : resultRef, review: review ? resultRef : null, result: resultRef, criteria: criteriaRef, comparisonTask: comparisonReceipt, blindMapping: task.inputIds },
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
    if (review) caveats.push('该场保留待核，没有正式胜负结论。');
    if (candidates.some(candidate => candidate.standardConflict)) caveats.push('归因记录标记标准答案冲突；保留原标准、核验说明与原判，不将标准视为已获独立验证。');
    if (caveats.length) pair.presentation.decision.caveat = caveats.join('');
    item.pairs.push(pair);
  }
  assert.equal(usedComparisons.size, comparisonRows.length);
  assert.equal(usedReviews.size, reviewRows.length);
  const cases = [...caseMap.values()];
  for (const item of cases) {
    assert.ok(item.pairs.length);
    item.pairs.sort((a, b) => Number(a.status === 'needs_review') - Number(b.status === 'needs_review') || Number(a.tier !== 'Fast') - Number(b.tier !== 'Fast'));
    item.defaultPairId = item.pairs[0].id;
    item.provenance = { runId: state.runId, case: { batch_id: item.batchId, case_id: item.caseId }, inputIds: item.inputIds };
    delete item.inputIds;
  }
  const countVersions = rows => Object.fromEntries([...new Set(rows.map(row => row.value.evaluator_version))].map(version => [version, rows.filter(row => row.value.evaluator_version === version).length]));
  return {
    meta: { runId: state.runId, runStatus: state.status, evaluator: [...new Set([...comparisonRows, ...reviewRows].map(row => row.value.evaluator_version))].join(' / '), evaluatorVersions: countVersions(comparisonRows), configuredEvaluator: state.evaluatorVersion, judgeModels: stats.judge_models, snapshotAt: snapshotAt ?? new Date().toISOString(), startedAt: state.startedAt, finishedAt: state.finishedAt, caseCount: cases.length, pairCount: comparisonRows.length + reviewRows.length, decidedCount: comparisonRows.length, pendingCount: reviewRows.length, inputCount: rawInputs.size, attributionCount: attributionRows.length, criteriaCount: criteriaRows.length, standardCaseCount: cases.filter(item => item.pairs[0].hasStandardAnswer).length, stageEvaluators: { criteria: countVersions(criteriaRows), attribution: countVersions(attributionRows), comparison: countVersions(comparisonRows), review: countVersions(reviewRows) }, clusteringEnabled: state.config.clustering.enabled, sourceRun: rel(runDir), sourceValidation: stats.validation, sourceProvenance: { state: rel(stateFile), stats: rel(resolve(runDir, 'stats.json')) } },
    limits: { reviewRounds: 1 }, cases,
  };
}

export async function writeSnapshot(snapshot, output) {
  // Escaping '<' keeps answer text such as </script> inert when build.mjs inlines this file.
  const json = JSON.stringify(snapshot, null, 2).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  await writeFile(output, `// 显式离线更新生成；页面与构建不读取原始数据。\nwindow.EvaluationReportData = ${json};\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const runDir = option('--run');
  if (!runDir) throw new Error('Usage: node evaluation-report/scripts/snapshot.mjs --run data/runs/comparison/<run-id> [--output /absolute/data.js]');
  const output = resolve(option('--output') ?? resolve(moduleDir, '../src/data/cases.js'));
  const snapshot = await buildSnapshot({ runDir });
  await writeSnapshot(snapshot, output);
  console.log(`Snapshot: ${snapshot.meta.caseCount} cases / ${snapshot.meta.pairCount} pairings (${snapshot.meta.decidedCount} decided, ${snapshot.meta.pendingCount} pending) → ${output}`);
}
