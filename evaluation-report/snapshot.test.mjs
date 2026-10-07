import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { effectiveReference, evidenceCoordinates, extractFinalAnswer, readJsonLines, writeSnapshot } from './snapshot.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '..');
const text = await readFile(resolve(directory, 'src/data.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(text, context);
const report = JSON.parse(JSON.stringify(context.window.EvaluationReportData));
const allPairs = report.cases.flatMap(item => item.pairs);

function verifyEvidenceExcerpts(value, original, source, pointer = '') {
  if (Array.isArray(original)) {
    assert.equal(value.length, original.length);
    original.forEach((item, index) => verifyEvidenceExcerpts(value[index], item, source, `${pointer}/${index}`));
  } else if (original && typeof original === 'object') {
    if (Number.isInteger(original.message_index) && typeof original.quote === 'string') {
      const chars = [...original.quote];
      assert.equal(value.quoteCharacters, chars.length);
      assert.equal(value.quoteTruncated, chars.length > 1600);
      assert.equal(value.quoteExcerpt, chars.length <= 1600 ? original.quote : chars.slice(0, 1200).join('') + `\n\n[……中间省略 ${chars.length - 1600} 字符……]\n\n` + chars.slice(-400).join(''));
      assert.deepEqual(value.provenance, { ...source, pointer: `${pointer}/quote` });
      assert.equal('quote' in value, false);
    } else {
      for (const [key, item] of Object.entries(original)) verifyEvidenceExcerpts(value[key], item, source, `${pointer}/${key}`);
    }
  }
}

test('snapshot covers 30 questions and all 42 accepted pairings without promoting pending reviews', () => {
  assert.equal(report.cases.length, 30);
  assert.equal(new Set(report.cases.map(item => JSON.stringify([item.batchId, item.caseId]))).size, 30);
  assert.equal(allPairs.length, 42);
  assert.equal(new Set(allPairs.map(pair => pair.id)).size, 42);
  assert.equal(allPairs.filter(pair => pair.status === 'decided').length, 37);
  assert.equal(allPairs.filter(pair => pair.status === 'needs_review').length, 5);
  assert.equal(report.cases.filter(item => item.pairs.every(pair => pair.status === 'needs_review')).length, 1);
  assert.equal(new Set(allPairs.flatMap(pair => pair.candidates.map(candidate => candidate.inputId))).size, 84);
  assert.equal(report.meta.configuredEvaluator, 'r152');
  assert.deepEqual(report.meta.evaluatorVersions, { r151: 35, r152: 2 });
  assert.equal(report.meta.sourceValidation.delivery.valid, false);
  assert.equal('experiments' in report, false, 'Experiments are maintained in their independent data file');
  for (const pair of allPairs) {
    assert.equal(pair.hasStandardAnswer, pair.groundTruth.available);
    assert.equal(pair.presentation.kind, pair.hasStandardAnswer ? '客观题' : '主观题');
    if (pair.status === 'needs_review') {
      assert.equal(pair.outcome, 'needs_review');
      assert.equal(pair.verdict, null);
      assert.equal(pair.winnerIndex, null);
      assert.equal(pair.provenance.comparison, null);
      assert.ok(pair.provenance.review);
      assert.ok(pair.reviewRequests.length);
    } else {
      assert.ok(pair.provenance.comparison);
      assert.equal(pair.provenance.review, null);
      assert.equal(pair.outcome, pair.verdict.result);
      assert.equal(pair.winnerIndex === null ? null : pair.candidates[pair.winnerIndex].version, pair.verdict.winner_version);
    }
  }
});

test('all shared requirements and comparison items remain available without summary truncation', () => {
  for (const pair of allPairs) {
    const requirements = pair.criteria.filter(item => item.group === 'requirements');
    assert.deepEqual(pair.presentation.checklist, requirements.filter(item => item.scope === 'shared').map(item => item.text));
    assert.equal(pair.criteriaSummary.shared, requirements.filter(item => item.scope === 'shared').length, 'Red flags and scoring points do not become common delivery requirements');
    assert.equal(pair.criteriaSummary.candidateSpecific, requirements.filter(item => item.scope !== 'shared' && item.applicableIndices.length).length);
    assert.equal(new Set(pair.criteria.map(item => item.id)).size, pair.criteria.length);
    for (const criterion of pair.criteria) {
      assert.ok(['requirements', 'scoring_points', 'red_flags'].includes(criterion.group));
      assert.ok(criterion.provenance.pointer.startsWith(`/result/${criterion.group}/`));
    }
    assert.equal(pair.presentation.matrixRows.length, pair.comparisons.length);
    assert.deepEqual(pair.presentation.matrixRows.flatMap(item => item.comparisonIndices), pair.comparisons.map((_, index) => index));
    pair.comparisons.forEach((item, index) => {
      assert.deepEqual(pair.presentation.matrixRows[index].values, item.cells);
      assert.equal(pair.presentation.matrixRows[index].label, item.topic);
      assert.equal(item.cells.length, 2);
      assert.ok(item.betterIndices.every(value => value === 0 || value === 1));
    });
    for (const candidate of pair.candidates) {
      assert.ok(candidate.finalAnswer.length > 0);
      assert.ok(candidate.finalAnswerParts.length > 0);
      assert.ok(Array.isArray(candidate.criteriaAssessments));
      assert.ok(candidate.criteriaAssessments.every(assessment => pair.criteria.some(criterion => criterion.id === assessment.criterion_id)), 'Every accepted assessment keeps its original criterion, including red flags');
      assert.ok(candidate.provenance.source.file.startsWith('data/sources/model-answers/'));
      assert.ok(candidate.answerReferences.every(reference => reference.renderAsText === true));
      assert.ok(candidate.answerReferences.every(reference => !reference.value?.startsWith('data:')));
      assert.ok(candidate.findings.every(finding => !finding.evidence?.some(evidence => 'quote' in evidence)));
    }
  }
  assert.equal(text.includes('data:image/'), false, 'Snapshot does not copy image binaries');
});

test('standards respect explicit exclusion and conflict checks instead of using model answers', () => {
  assert.equal(effectiveReference({ has_standard_answer: false, meta: { std_answer: 'not a valid standard' } }), null);
  assert.equal(effectiveReference({ meta: { std_answer: 0 } }), 0);
  assert.throws(() => effectiveReference({ meta: { ground_truth: 'one', std_answer: 'two' } }), /Conflicting standards/);
  assert.equal(effectiveReference({ meta: { context: [{ answer: 'a generated answer' }] } }), null);
});

test('evidence excerpts preserve short quotes and exactly bound long Unicode quotes', () => {
  const source = { file: 'results/attribution.jsonl', line: 2 };
  for (const quote of ['短证据', '字'.repeat(1600), '头'.repeat(1200) + '中' + '尾'.repeat(400), '😀'.repeat(1601)]) {
    const original = { evidence: [{ evidence_id: 'ev-test', message_index: 3, quote }] };
    const projected = evidenceCoordinates(original, source, '/evaluation/findings/0');
    verifyEvidenceExcerpts(projected, original, source, '/evaluation/findings/0');
    assert.equal(projected.evidence[0].evidence_id, 'ev-test');
    assert.equal(projected.evidence[0].message_index, 3);
  }
});

test('full answer extraction keeps every textual block and retains inert external references', () => {
  const raw = { messages: [{ content: [
    { type: 'output_text', text: '首段\n完整正文' },
    { type: 'output_image', image_url: { url: 'https://example.invalid/original.png' } },
    { type: 'output_text', text: '末段\n<vis-html ref="figure-id"/>' },
    { type: 'output_image', image_url: { url: 'data:image/png;base64,AA==' } },
  ] }] };
  const answer = extractFinalAnswer(raw, 0);
  assert.equal(answer.finalAnswer, '首段\n完整正文\n\n末段\n<vis-html ref="figure-id"/>');
  assert.equal(answer.references.length, 3);
  assert.equal(answer.references[0].value, 'https://example.invalid/original.png');
  assert.equal(answer.references[2].embeddedData, true);
  assert.equal(answer.references[2].value, null);
});

test('physical source line reader counts LF only and does not parse unselected records', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'report-source-lines-'));
  try {
    const file = resolve(temp, 'selected.jsonl');
    await writeFile(file, 'unselected\rtext\n{"id":2,"text":"a\\nb"}\n{"id":3}\n');
    assert.deepEqual(await readJsonLines(file, new Set([2])), [{ line: 2, value: { id: 2, text: 'a\nb' } }]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('generated JavaScript preserves answer text and cannot terminate an inline script', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'report-safe-script-'));
  try {
    const file = resolve(temp, 'data.js');
    const sample = { finalAnswer: '</script><script>unsafe()</script>\u2028tail' };
    await writeSnapshot(sample, file);
    const script = await readFile(file, 'utf8');
    assert.equal(script.includes('</script>'), false);
    const result = { window: {} };
    vm.runInNewContext(script, result);
    assert.equal(result.window.EvaluationReportData.finalAnswer, sample.finalAnswer);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('optional source audit verifies all standards, full answers, task-linked attributions and formal decisions', async t => {
  const statePath = resolve(root, report.meta.sourceProvenance.state);
  try { await access(statePath); } catch { t.skip('Original run is not available beside this standalone snapshot'); return; }
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const requiredFiles = new Set(allPairs.flatMap(pair => [pair.provenance.result.file, pair.provenance.criteria.file, ...pair.candidates.flatMap(candidate => [candidate.provenance.source.file, candidate.provenance.attribution.file]) ]));
  for (const file of requiredFiles) {
    try { await access(resolve(root, file)); }
    catch { t.skip(`Original source is unavailable: ${file}`); return; }
  }
  const needed = new Map();
  for (const pair of allPairs) {
    for (const ref of [pair.provenance.result, pair.provenance.criteria, ...pair.candidates.flatMap(candidate => [candidate.provenance.source, candidate.provenance.attribution])]) {
      if (!needed.has(ref.file)) needed.set(ref.file, new Set());
      needed.get(ref.file).add(ref.line);
    }
  }
  const sources = new Map();
  for (const [file, lines] of needed) sources.set(file, new Map((await readJsonLines(resolve(root, file), lines)).map(row => [row.line, row.value])));
  const rowAt = ref => sources.get(ref.file).get(ref.line);
  const seenIds = new Set();
  for (const item of report.cases) {
    for (const pair of item.pairs) {
      const formalRow = rowAt(pair.provenance.result);
      assert.equal(formalRow.comparison_id, pair.id);
      assert.equal(formalRow.evaluator_version, pair.evaluatorVersion);
      const formal = pair.status === 'needs_review' ? formalRow.result : formalRow;
      assert.deepEqual(pair.originalDecisionBasis, formal.decision_basis);
      assert.equal(pair.presentation.decision.summary, formal.decision_basis.tradeoff);
      assert.equal(pair.comparisons.length, formal.decision_basis.comparisons.length);
      const criteria = rowAt(pair.provenance.criteria);
      assert.deepEqual(pair.presentation.checklist, criteria.result.requirements.filter(requirement => requirement.applies_to.length === 0).map(requirement => requirement.text));
      const criterionGroups = ['requirements', 'scoring_points', 'red_flags'];
      assert.equal(pair.criteria.length, criterionGroups.reduce((count, group) => count + criteria.result[group].length, 0), 'Snapshot retains all three original criterion groups');
      for (const group of criterionGroups) {
        const projected = pair.criteria.filter(criterion => criterion.group === group);
        assert.equal(projected.length, criteria.result[group].length);
        projected.forEach((criterion, index) => {
          const original = criteria.result[group][index];
          for (const [key, value] of Object.entries(original)) assert.deepEqual(criterion[key], value, 'Criterion source wording and applicability remain unchanged');
          assert.deepEqual(criterion.provenance, {...pair.provenance.criteria, pointer: `/result/${group}/${index}`});
        });
      }
      for (const candidate of pair.candidates) {
        seenIds.add(candidate.inputId);
        const input = state.inputs[candidate.inputId];
        const raw = rowAt(candidate.provenance.source);
        assert.equal(raw.case_id, item.caseId);
        assert.equal(raw.batch_id, item.batchId);
        assert.equal(input.question, item.question);
        assert.deepEqual(effectiveReference(raw), input.reference);
        const content = raw.messages[input.final_index].content;
        const fullText = typeof content === 'string' ? content : content.filter(part => typeof part.text === 'string').map(part => part.text).join('\n\n');
        assert.equal(candidate.finalAnswer, fullText, 'Final answer must not be an excerpt');
        const attribution = rowAt(candidate.provenance.attribution);
        const dependency = state.tasks[pair.provenance.comparisonTask.taskId].dependencies[candidate.label];
        assert.equal(attribution.task_id, dependency, 'Use the comparison dependency, including reviewed attribution');
        assert.equal(attribution.input_id, candidate.inputId);
        assert.deepEqual(candidate.core, attribution.evaluation.core_assessment);
        assert.equal(candidate.standardConflict, attribution.evaluation.standard_conflict === true);
        assert.equal(candidate.findings.length, attribution.evaluation.findings.length);
        candidate.findings.forEach((finding, index) => {
          const original = attribution.evaluation.findings[index];
          for (const key of ['finding_id', 'type', 'text', 'reason', 'problem', 'assessment']) assert.deepEqual(finding[key], original[key]);
        });
        assert.deepEqual(candidate.criteriaAssessments.map(({ evidence, ...rest }) => rest), attribution.evaluation.criterion_assessments.map(({ evidence, ...rest }) => rest));
        for (const [snapshotKey, originalKey] of [['findings', 'findings'], ['criteriaAssessments', 'criterion_assessments'], ['numericChecks', 'numeric_checks'], ['correctnessEvidence', 'correctness_evidence']]) {
          verifyEvidenceExcerpts(candidate[snapshotKey], attribution.evaluation[originalKey], candidate.provenance.attribution, `/evaluation/${originalKey}`);
        }
      }
      if (pair.status === 'decided') {
        assert.deepEqual(pair.groundTruth, formal.ground_truth);
        assert.equal(pair.hasStandardAnswer, formal.has_standard_answer);
        assert.deepEqual(pair.verdict, Object.values(formal.verdicts)[0]);
      }
    }
  }
  assert.equal(seenIds.size, Object.keys(state.inputs).length, 'No selected question or input is silently omitted');
});
