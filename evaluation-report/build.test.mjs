import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { buildReport } from './build.mjs';

const directory = dirname(fileURLToPath(import.meta.url));

test('离线导出内联全部展示资源，并完整保留内容快照', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'evaluation-report-'));
  try {
    const output = await buildReport({ output: join(temporary, '汇报.html') });
    const html = await readFile(output, 'utf8');
    assert.match(html, /<html\b[^>]*data-standalone="true"/);
    assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:src|href)=["']src\//);
    assert.equal([...html.matchAll(/<style\b/g)].length, 2);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    assert.equal(scripts.length, 6);
    assert.deepEqual(scripts.map(([, attributes]) => attributes.match(/data-source="([^"]+)"/)?.[1]), [
      'src/data.js', 'src/motion.js', 'src/icons.js', 'src/diagram-interaction.js', 'src/flow.js', 'src/app.js',
    ]);
    for (const [, , script] of scripts) new vm.Script(script);
    const embedded = scripts.find(([, attributes]) => /id="report-data"/.test(attributes))?.[2];
    assert.ok(embedded, '导出必须保留 report-data 标识，供新增结果回写');
    const source = { window: {} };
    const result = { window: {} };
    vm.runInNewContext(await readFile(join(directory, 'src/data.js'), 'utf8'), source);
    vm.runInNewContext(embedded, result);
    assert.equal(JSON.stringify(result.window.EvaluationReportData), JSON.stringify(source.window.EvaluationReportData));
    assert.equal(result.window.EvaluationReportData.prompts.length, 23);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('导出不能覆盖页面或样式、数据、逻辑源文件', async () => {
  for (const path of ['index.html', 'src/tokens.css', 'src/styles.css', 'src/data.js', 'src/motion.js', 'src/icons.js', 'src/diagram-interaction.js', 'src/flow.js', 'src/app.js', 'build.mjs', 'build.test.mjs', 'interaction.test.mjs', 'README.md', 'PHOSPHOR-LICENSE.txt']) {
    await assert.rejects(buildReport({ output: join(directory, path) }), /不能覆盖汇报源文件/);
  }
});

test('汇报快照的对局分母、阶段产出与原文节选保持一致', async () => {
  const context = { window: {} };
  vm.runInNewContext(await readFile(join(directory, 'src/data.js'), 'utf8'), context);
  const report = context.window.EvaluationReportData;
  for (const run of report.metrics.runs) {
    const results = run.formal_results;
    assert.equal(Object.values(results.outcomes).reduce((sum, count) => sum + count, 0), results.comparison_rows);
    assert.equal(results.comparison_rows + results.comparison_not_decided, run.sample.planned_comparisons);
    assert.equal(results.criteria_rows, run.tasks_by_stage.criteria.succeeded || 0);
    assert.equal(results.attribution_rows, run.tasks_by_stage.attribution.succeeded || 0);
    assert.equal(results.comparison_rows, run.tasks_by_stage.comparison.succeeded || 0);
    assert.ok(results.distinct_cases_with_comparison <= run.sample.business_cases);
    assert.ok(run.semantic_review.status, '模型产出必须保留独立的语义复核状态');
  }
  for (const brief of report.promptBriefs) {
    const source = report.prompts.find(prompt => prompt.id === `${brief.agent.toLowerCase()}/system`);
    assert.ok(source?.text.includes(brief.quote), `${brief.agent} 摘录必须逐字来自对应原文`);
  }
});
