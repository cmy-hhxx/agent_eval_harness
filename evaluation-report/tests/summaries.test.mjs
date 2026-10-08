import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
const context={window:{}};
for(const name of ['cases','case-summaries'])vm.runInNewContext(await readFile(new URL(`../src/data/${name}.js`,import.meta.url),'utf8'),context);
const summaries=context.window.ReportCaseSummaries;
test('42场主图短稿逐项覆盖全部202比较，保留适用与待核边界',()=>{
 const pairs=context.window.EvaluationReportData.cases.flatMap(c=>c.pairs);
 assert.equal(Object.keys(summaries).length,pairs.length);
 let total=0;
 for(const pair of pairs){
  const view=summaries[pair.id];assert.ok(view,pair.title);
  assert.equal(view.checks.length,2);assert.equal(view.rows.length,pair.comparisons.length);
  view.checks.forEach(check=>assert.ok([...check].length<=38));
  for(const [index,row] of view.rows.entries()){
   assert.deepEqual(Array.from(row.comparisonIndices),[index]);assert.equal(row.values.length,2);assert.ok([...row.label].length<=10);
   row.values.forEach((value,candidate)=>{
    assert.ok([...value].length<=48);
    const original=pair.comparisons[index];
    if(original.statuses[candidate]==='not_applicable')assert.match(value,/不适用|无.*要求|无.*约束|无.*专属|只适用于另一候选/);
    if(original.evidenceStatuses[candidate]==='uncertain')assert.match(value,/待核|未确认|未核实|未证实|不确定/);
   });total++;
  }
 }
 assert.equal(total,202);
});
