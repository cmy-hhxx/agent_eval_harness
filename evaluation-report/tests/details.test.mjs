import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const [source, dataSource] = await Promise.all([
  readFile(join(directory, 'src/pages/flow/details.js'), 'utf8'),
  readFile(join(directory, 'src/data/cases.js'), 'utf8'),
]);
const sandbox = {window:{}};
vm.runInNewContext(dataSource, sandbox);
const report = JSON.parse(JSON.stringify(sandbox.window.EvaluationReportData));
const examples = report.cases.flatMap(group => group.pairs.flatMap(pair => pair.candidates.map(candidate => ({pair,candidate}))));

function environment(t) {
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<dialog class="case-detail"><div class="case-detail-body"></div></dialog>', {runScripts:'outside-only',virtualConsole:console});
  dom.window.eval(source);
  const body = dom.window.document.querySelector('.case-detail-body');
  t.after(() => {dom.window.close();assert.deepEqual(errors,[]);});
  return {body,window:dom.window,render(example,anonymous=value=>value){dom.window.ReportDetails.renderCheck(body,{...example,anonymous});}};
}

function assertEvidence(container, entries, kind) {
  const nodes = [...container.querySelectorAll(`[data-check-evidence="${kind}"]`)];
  assert.equal(nodes.length, entries.length);
  nodes.forEach((node,index) => {
    const evidence = entries[index];
    assert.equal(node.dataset.evidenceIndex, String(index));
    assert.equal(node.dataset.evidenceId, evidence.evidence_id);
    assert.equal(node.querySelector('[data-evidence-quote]').textContent, evidence.quoteExcerpt, '证据只能显示已有原文/摘录，不做匿名文案替换或补写');
    assert.equal(node.querySelector('summary').textContent, `证据 ${index+1} · ${evidence.quoteTruncated?'摘录':'原文'} · 消息 ${evidence.message_index}`);
    if (evidence.provenance) assert.ok(node.querySelector('.source-reference').textContent.includes(evidence.provenance.file));
  });
}

test('84份归因完整呈现424项核验、491条发现、53条数值和115条正确性证据', t => {
  const page = environment(t);
  assert.equal(examples.length,84);
  const totals={assessments:0,findings:0,numeric:0,correctness:0};
  for (const {pair,candidate} of examples) {
    page.render({pair,candidate});
    assert.equal(page.body.querySelector('[data-check-output]').dataset.checkOutput,candidate.inputId);
    assert.equal(page.body.querySelector('[data-check-core-reason]').textContent,candidate.core.reason);
    if (candidate.summary!==candidate.core.reason) assert.equal(page.body.querySelector('[data-check-summary]').textContent,candidate.summary);
    else assert.equal(page.body.querySelector('[data-check-summary]'),null);
    assert.ok(page.body.querySelector('[data-check-source]').textContent.includes(candidate.provenance.attribution.file));
    const assessments=[...page.body.querySelectorAll('[data-check-assessment]')];
    assert.equal(assessments.length,candidate.criteriaAssessments.length);
    totals.assessments+=assessments.length;
    assessments.forEach((node,index)=>{
      const assessment=candidate.criteriaAssessments[index],criterion=pair.criteria.find(rule=>rule.id===assessment.criterion_id);
      assert.equal(node.dataset.checkAssessment,assessment.criterion_id);
      assert.equal(node.querySelector('[data-assessment-status]').dataset.assessmentStatus,assessment.status);
      assert.equal(node.querySelector('[data-assessment-status]').dataset.assessmentEvidenceStatus,assessment.evidence_status);
      if (criterion) {
        assert.equal(node.querySelector('[data-criterion-text]').textContent,criterion.text);
        assert.equal(node.querySelector('[data-criterion-acceptance]').textContent,criterion.acceptance_rule);
        assert.equal(node.querySelector('[data-criterion-scope]').dataset.criterionScope,criterion.scope);
      } else {
        assert.equal(node.querySelector('[data-criterion-text],[data-criterion-acceptance]'),null,'没有快照原句的判据只保留已有核验，不能补造标准');
      }
      assert.equal(node.querySelector('[data-assessment-summary]').textContent,assessment.summary);
      assertEvidence(node,assessment.evidence,'criterion');
    });
    const findings=[...page.body.querySelectorAll('[data-check-finding]')];
    assert.deepEqual(findings.map(node=>node.dataset.checkFinding).sort(),candidate.findings.map(finding=>finding.finding_id).sort(), '所有优点和问题都保留原finding身份');
    totals.findings+=findings.length;
    for (const finding of candidate.findings) {
      const node=findings.find(node=>node.dataset.checkFinding===finding.finding_id);
      assert.equal(node.closest('[data-check-finding-group]').dataset.checkFindingGroup,finding.type);
      assert.equal(node.querySelector('[data-finding-text]').textContent,finding.text);
      assert.equal(node.querySelector('[data-finding-reason]').textContent,finding.reason);
      assert.ok(node.textContent.includes(finding.assessment.observation));
      assert.ok(node.textContent.includes(finding.assessment.impact));
      assert.equal(node.querySelector('[data-finding-evidence-status]').dataset.findingEvidenceStatus,finding.assessment.evidence_status);
      if (finding.problem) {
        assert.equal(node.querySelector('[data-problem-label]').textContent,finding.problem.label);
        assert.equal(node.querySelector('[data-problem-definition]').textContent,finding.problem.definition);
        assert.equal(node.querySelector('[data-problem-components]').textContent,finding.problem.component.length?finding.problem.component.join(' / '):'责任待定位');
      }
      assertEvidence(node,finding.evidence,'finding');
    }
    const correctness=page.body.querySelector('[data-check-correctness]');
    if (!pair.hasStandardAnswer) {
      assert.equal(correctness,null,'无标准的归因不显示空标准核对区');
      assert.equal(page.body.querySelector('[data-check-numeric]'),null);
    } else {
      assert.ok(correctness);
      assert.equal(correctness.querySelector('[data-correctness-state]').dataset.correctnessState,String(candidate.isCorrect));
      assert.equal(!!correctness.querySelector('[data-standard-conflict]'),candidate.standardConflict);
      assert.equal(correctness.querySelector('[data-check-correctness-reason]').textContent,candidate.correctnessReason);
      const numeric=[...correctness.querySelectorAll('[data-numeric-index]')];
      assert.equal(numeric.length,candidate.numericChecks.length);
      totals.numeric+=numeric.length;
      numeric.forEach((row,index)=>{
        const check=candidate.numericChecks[index];
        for(const field of ['label','expected','actual','scale'])assert.equal(row.querySelector(`[data-numeric-field="${field}"]`).textContent,check[field]===null?'未给出':check[field]);
        assert.equal(row.querySelector('[data-numeric-field="actual"]').dataset.valueAvailable,String(check.actual!==null),'没有实际数值时不能用零或空串冒充');
        assert.equal(row.querySelector('[data-numeric-mode]').dataset.numericMode,check.mode);
        assert.equal(row.querySelector('[data-numeric-matches]').dataset.numericMatches,String(check.matches));
        assert.equal(row.dataset.numericEvidenceIndex,String(check.evidence_index));
        assert.ok(candidate.correctnessEvidence[check.evidence_index],'每条数值保留对应正确性证据的索引');
      });
      assertEvidence(correctness,candidate.correctnessEvidence,'correctness');
      totals.correctness+=candidate.correctnessEvidence.length;
    }
  }
  assert.deepEqual(totals,{assessments:424,findings:491,numeric:53,correctness:115});
});

test('数值核验保留标准4687、实际4575、精度与冲突标记，不把标准冲突改成正确', t => {
  const page=environment(t);
  const example=examples.find(({candidate})=>candidate.numericChecks.some(check=>check.expected==='4687'&&check.actual==='4575'));
  assert.ok(example);
  page.render(example);
  assert.equal(page.body.querySelector('[data-correctness-state]').textContent,'未匹配标准');
  assert.equal(page.body.querySelector('[data-standard-conflict]').textContent,'标准冲突');
  const row=page.body.querySelector('[data-numeric-index="0"]');
  assert.equal(row.querySelector('[data-numeric-field="expected"]').textContent,'4687');
  assert.equal(row.querySelector('[data-numeric-field="actual"]').textContent,'4575');
  assert.equal(row.querySelector('[data-numeric-field="scale"]').textContent,'1');
  assert.equal(row.querySelector('[data-numeric-mode]').dataset.numericMode,'exact');
  assert.equal(row.querySelector('[data-numeric-matches]').textContent,'不一致');
});

test('不重复相同总结；匿名化只处理评语，原证据和数值保持字面值', t => {
  const page=environment(t);
  const example=structuredClone(examples.find(({pair})=>!pair.hasStandardAnswer));
  example.candidate.summary=example.candidate.core.reason='回答①的唯一归因总结。';
  example.candidate.criteriaAssessments[0].evidence[0].quoteExcerpt='原句：回答①给出 A股结论。';
  example.candidate.criteriaAssessments[0].evidence[0].quoteTruncated=false;
  page.render(example,value=>value.replaceAll('回答①','B'));
  assert.equal(page.body.querySelector('[data-check-core-reason]').textContent,'B的唯一归因总结。');
  assert.equal(page.body.querySelector('[data-check-summary]'),null);
  assert.equal(page.body.textContent.split('B的唯一归因总结。').length-1,1);
  assert.equal(page.body.querySelector('[data-check-evidence="criterion"] [data-evidence-quote]').textContent,'原句：回答①给出 A股结论。');
  page.render(example,value=>value.replaceAll('回答①','A'));
  assert.equal(page.body.querySelectorAll('[data-check-output]').length,1);
  assert.equal(page.body.querySelector('[data-check-core-reason]').textContent,'A的唯一归因总结。');
});

test('评语、规则、责任与证据中的HTML全部作为文本，不能执行或加载资源', t => {
  const page=environment(t);
  const example=structuredClone(examples.find(({candidate})=>candidate.numericChecks.length));
  const attack='<img src="https://example.invalid/private" onerror="window.infected=true"><script>window.infected=true</script>';
  example.candidate.summary=attack;
  example.candidate.core.reason=attack;
  example.candidate.findings[0].text=attack;
  example.candidate.findings[0].reason=attack;
  example.candidate.criteriaAssessments[0].summary=attack;
  example.candidate.criteriaAssessments[0].evidence[0].quoteExcerpt=attack;
  example.candidate.numericChecks[0].label=attack;
  example.pair.criteria[0].text=attack;
  example.pair.criteria[0].acceptance_rule=attack;
  page.render(example);
  assert.ok(page.body.textContent.includes(attack));
  assert.equal(page.body.querySelector('script,img,iframe,svg,link,[onerror],a[href]'),null);
  assert.equal(page.window.infected,undefined);
});
