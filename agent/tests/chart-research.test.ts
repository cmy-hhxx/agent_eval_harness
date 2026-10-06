import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEris } from '@eval/assistant';
import { ROOT } from '../../tests/fixtures/services.js';
const data = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-data.js')).href);
const { chartFromToolOutput } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/charts.js')).href);
const { researchOption, ResearchChart } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-research.js')).href);
const { chartTemplates } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-templates.js')).href);
const { radialCells } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-radial.js')).href);
const base = { title: '比较实际指标', scope: '固定期间 · 样本 n=3', source: '测试来源', unit: '次', categories: ['甲', '乙', '丙'], series: [{ name: 'A组', values: [10, 20, 30] }] };
const samples = [
  { ...base, type: 'dumbbell', series: [...base.series, { name: 'B组', values: [12, null, 27] }] },
  { ...base, type: 'heatmap', series: [...base.series, { name: 'B组', values: [5, null, 0] }], annotations: [{ categoryIndex: 2, seriesIndex: 0, note: '问题集中在丙' }] },
  { ...base, type: 'scatter', xValues: [2, 4, 9], xLabel: '时间', xUnit: '秒' },
  { ...base, type: 'waterfall', series: [{ name: '金额变动', values: [100, -130, 40] }] },
  { ...base, type: 'histogram' },
];
const context = { scope: { userId: 'test', sessionId: 'test' }, callId: 'chart', signal: new AbortController().signal, progress() {} };
const unexpected = async (): Promise<never> => { throw new Error('Unexpected dependency'); };
const eris = createEris({ data: { list: async () => ({ kind: 'inputs' }), read: unexpected, search: unexpected, image: unexpected }, specialists: { invoke: unexpected, read: unexpected }, save: unexpected, search: { search: unexpected }, web: { read: unexpected } });
const tool = eris.tools.find(t => t.name === 'show_chart')!;

test('all research charts pass the public tool contract and remain readable after serialization', async () => {
  for (const chart of samples) {
    const result = await tool.execute({ ...chart, references: [{ runId: 'test' }] }, context);
    assert.deepEqual(chartFromToolOutput(result.content[0].text, 'ok'), chart);
    const options = researchOption(chart, 514);
    assert(options.series.length > 0);
    assert.equal(options.animation, false);
    assert.equal(options.tooltip.show, false);
    assert.equal(options.tooltip.triggerOn, 'none');
  }
});

test('research chart geometry preserves unknown pairs, raw distribution counts and signed cumulative values', () => {
  const dumbbell = researchOption(samples[0]);
  assert.equal(dumbbell.series[0].data.length, 2, 'a missing endpoint has no fabricated connector');
  assert.equal(dumbbell.series[2].data.length, 2);
  const heatmap = researchOption(samples[1]);
  assert.equal(heatmap.series[0].data.length, 5, 'unknown is a missing cell; a recorded zero stays a cell');
  assert(heatmap.series[0].data.some((p: { value: number[] }) => p.value[2] === 0));
  assert.deepEqual(heatmap.series.at(-1).data[0], [2, 0]);
  assert.deepEqual(data.waterfallSteps(samples[3]).map((s: { start: number; end: number }) => [s.start, s.end]), [[0, 100], [100, -30], [-30, 10], [0, 10]]);
  for (const values of [[1, 1, 1], [-5, 0, 5, 10], [0, 0, 0, 1, 10]]) {
    const bins = data.histogramBins(values);
    assert.equal(bins.reduce((sum: number, bin: { count: number }) => sum + bin.count, 0), values.length);
    assert.equal(bins.at(-1).high, Math.max(...values));
  }
  assert.deepEqual(data.pairedDifferences(samples[0]).map((pair: { value: number | null }) => pair.value), [2, null, -3]);
  assert.equal(data.decimalSum([0.1, 0.2]), 0.3);
  assert.equal(data.differenceUnit({ ...samples[0], unit: '%' }), '百分点');
  assert.equal(data.chartReading(samples[1], { sourceSeries: 1, categoryIndex: 1 }, 0), '乙 · B组：未知');
  assert.equal(data.chartReading(samples[2], { sourceSeries: 0, categoryIndex: 2 }, 0), '丙 · 时间：9 秒 · A组：30 次');
});

test('invalid analytic shapes and unsupported annotations fail before source access', async () => {
  for (const chart of [
    { ...samples[0], series: base.series }, { ...samples[2], xValues: [1, 2] },
    { ...samples[2], xValues: [1, null, 3] }, { ...samples[2], xLabel: '' },
    { ...samples[3], series: [{ name: 'A', values: [1, null, 2] }] },
    { ...samples[4], series: [...base.series, ...base.series] },
    { ...samples[1], annotations: [{ categoryIndex: 1, seriesIndex: 1, note: '不存在的点' }] },
    { ...samples[1], annotations: [{ categoryIndex: 5, seriesIndex: 0, note: '越界' }] },
  ]) {
    await assert.rejects(tool.execute({ ...chart, references: [{ runId: 'test' }] }, context));
    assert.equal(chartFromToolOutput(JSON.stringify({ kind: 'chart', chart }), 'ok'), null);
  }
});

test('compact layers use observed quartiles and keep unknown differences unknown', () => {
  assert.equal(data.quantile([1, 2, 3, 4], .5), 2.5);
  assert.equal(data.quantile([1, 2, 3, 4], .25), 1.75);
  const matrix = researchOption(samples[1]);
  const delta = matrix.series.find((s: { data?: { derived?: string }[] }) => s.data?.[0]?.derived === 'difference');
  assert(delta);
  assert.deepEqual(data.pairedDifferences(samples[1]).map((p: { value: number | null }) => p.value), [-5, null, -30]);
  assert.equal(data.chartReading(samples[1], { derived: 'difference', categoryIndex: 1 }, 0), '乙 · B组 − A组：未知');
  const scatter = researchOption(samples[2]);
  assert.deepEqual(scatter.series[0].markLine.data, [{ xAxis: 4 }, { yAxis: 20 }]);
  const histogram = researchOption(samples[4]);
  assert.equal(histogram.xAxis.type, 'value');
  assert.equal(histogram.series[1].data.length, 3, 'the rug represents the original observations');
  assert.deepEqual(histogram.series[0].markArea.data, [[{ xAxis: 15 }, { xAxis: 25 }]]);
  assert(data.compactNumber(1e-9).includes('E-9'), 'compact annotations never round a small observation to zero');
});

test('row charts size their real canvas to the data and keep count axes integral', () => {
  const small = { ...samples[0], categories: ['甲', '乙'], series: [{ name: 'A组', values: [4, 1] }, { name: 'B组', values: [3, 7] }] };
  const height = (chart: unknown, width = 514) => {
    const document = new JSDOM(renderToStaticMarkup(createElement(ResearchChart, { chart, width, english: false }))).window.document;
    return parseFloat(document.querySelector<HTMLElement>('[tabindex]')!.style.height);
  };
  assert(height(small) <= 120, 'two short rows do not reserve a tall canvas');
  assert(height(samples[0]) > height(small), 'additional rows receive their own space');
  const wide = researchOption({ ...small, categories: ['需要保留的完整长项目名称', '乙'] }, 300);
  assert(wide.yAxis.axisLabel.width > 78, 'long labels get horizontal space instead of being stacked into multiple lines');
  assert.equal(wide.yAxis.axisLabel.overflow, undefined);
  const counts = researchOption(small);
  assert.equal(counts.xAxis.minInterval, 1);
  assert.equal(counts.xAxis.axisLabel.showMinLabel, false, 'padded domain edges do not appear as fractional counts');
  assert.equal(researchOption({ ...small, series: [{ name: 'A组', values: [1.2, 1.4] }, { name: 'B组', values: [1.3, 1.7] }] }).xAxis.minInterval, 0, 'measured decimals remain allowed');
});

test('every local template uses the current tool contract and the same receipt renderer', async () => {
  assert.equal(new Set(chartTemplates.map((t: { chart: { type: string } }) => t.chart.type)).size, 16);
  for (const { chart } of chartTemplates) {
    const result = await tool.execute({ ...chart, references: [{ runId: 'test' }] }, context);
    assert.deepEqual(chartFromToolOutput(result.content[0].text, 'ok'), chart);
    if (data.researchTypes.includes(chart.type)) assert(researchOption(chart).series.length > 0);
  }
});

test('scientific templates preserve geometric meaning rather than manufacturing statistics', () => {
  const example = (type: string) => chartTemplates.find((t: { chart: { type: string } }) => t.chart.type === type).chart;
  const bubble = researchOption(example('bubble')).series[0];
  assert(Math.abs((bubble.symbolSize([0, 0, 20]) / bubble.symbolSize([0, 0, 10])) ** 2 - 2) < 1e-10, 'bubble area doubles when magnitude doubles');
  assert.equal(bubble.symbolSize([0, 0, 0]), 0, 'zero magnitude has zero area');
  assert.deepEqual(data.boxSummary([1, 2, 3, 4, 100]), { count: 5, q1: 2, median: 3, q3: 4, low: 1, high: 4 });
  const boxes = researchOption({ ...example('boxplot'), categories: ['a','b','c','d','e'], series: [{ name: 'A组', values: [1,2,3,4,100] }] });
  assert.equal(boxes.series[1].data.at(-1).value[1], 100, 'outliers remain visible as original observations');
  const constant = data.violinDensity([{ values: Array(8).fill(0) }]);
  assert(Number.isFinite(constant.bandwidth) && constant.bandwidth > 0);
  assert.equal(constant.groups[0].length, 1, 'constant data are not spread into a fabricated distribution');
  const radial = { ...example('radial_heatmap'), categories: ['甲','乙','丙'], series: [{ name: 'A组', values: [0,null,8] }, { name: 'B组', values: [0,-8,4] }] };
  const geometry = radialCells(radial, 344);
  assert.equal(geometry.cells.length, 6);
  assert.notEqual(geometry.cells[0].fill, geometry.cells[1].fill, 'zero and missing do not share a heat value');
  assert.equal(geometry.cells[0].fill, geometry.cells[3].fill, 'the same value has the same colour across rings');
  assert.equal(geometry.minimum, -8); assert.equal(geometry.maximum, 8);
  assert(geometry.cells.every((cell: { path: string }) => !/NaN|Infinity/.test(cell.path)));
});

test('scientific chart data requirements fail before any source is read', async () => {
  const example = (type: string) => chartTemplates.find((t: { chart: { type: string } }) => t.chart.type === type).chart;
  const invalid = [
    { ...example('radial_heatmap'), series: [base.series[0]] },
    { ...example('bubble'), sizeValues: [1,2] },
    { ...example('bubble'), sizeValues: [1,-2,3,4,5,6] },
    { ...example('bubble'), sizeValues: [null,null,null,null,5,6] },
    { ...example('bubble_matrix'), categories: ['甲'], series: [{ name: 'A', values: [-1] }] },
    { ...example('slope'), series: [{ name: 'A', values: [null,1] }] },
    { ...example('bump'), series: [{ name: 'A', values: [1,2.5,3,1] }] },
    { ...example('interval'), series: [{ name: 'A', values: [2,3,4], lowerValues: [1,4,3], upperValues: [3,5,6] }] },
    { ...example('interval'), series: [{ name: 'A', values: [2,null,4], lowerValues: [1,2,3], upperValues: [3,4,6] }] },
    { ...example('violin'), categories: ['a','b','c','d','e'], series: [{ name: 'A', values: [1,2,3,4,5] }] },
  ];
  for (const chart of invalid) {
    await assert.rejects(tool.execute({ ...chart, references: [{ runId: 'test' }] }, context));
    assert.equal(chartFromToolOutput(JSON.stringify({ kind: 'chart', chart }), 'ok'), null, chart.type);
  }
});
