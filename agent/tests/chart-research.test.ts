import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { init } from 'echarts/core';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEris } from '@eval/assistant';
import { ROOT } from '../../tests/fixtures/services.js';
const data = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-data.js')).href);
const { chartFromToolOutput } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/charts.js')).href);
const { researchOption, ResearchChart } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-research.js')).href);
const { chartTemplates } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-templates.js')).href);
const { roseRadius, chordArcs } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-structure-data.js')).href);
const { radialCells } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-radial.js')).href);
const base = { title: '比较实际指标', scope: '固定期间 · 样本 n=3', source: '测试来源', unit: '次', categories: ['甲', '乙', '丙'], series: [{ name: 'A组', values: [10, 20, 30] }] };
const samples = [
  { ...base, type: 'heatmap', series: [...base.series, { name: 'B组', values: [5, null, 0] }], annotations: [{ categoryIndex: 2, seriesIndex: 0, note: '问题集中在丙' }] },
  { ...base, type: 'scatter', xValues: [2, 4, 9], xLabel: '时间', xUnit: '秒' },
  { ...base, type: 'waterfall', series: [{ name: '金额变动', values: [100, -130, 40] }] },
  { ...base, type: 'histogram' },
];
const context = { scope: { userId: 'test', sessionId: 'test' }, callId: 'chart', signal: new AbortController().signal, progress() {} };
const unexpected = async (): Promise<never> => { throw new Error('Unexpected dependency'); };
const eris = createEris({ data: { list: async () => ({ kind: 'inputs' }), read: unexpected, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
const tool = eris.tools.find(t => t.name === 'show_chart')!;

test('Unicode text accepted by the tool remains a visible chart receipt at every text limit', async () => {
  const chart = { ...samples[1], title: '😀'.repeat(500), scope: '𠮷'.repeat(500), source: '😀'.repeat(500), unit: '😀'.repeat(40),
    categories: ['😀'.repeat(120), '𠮷'.repeat(120), '乙'], series: [{ name: '😀'.repeat(120), values: [1, 2, 3] }],
    xLabel: '😀'.repeat(80), xUnit: '😀'.repeat(40), annotations: [{ categoryIndex: 0, seriesIndex: 0, note: '😀'.repeat(100) }] };
  const result = await tool.execute(chart, context);
  assert.deepEqual(chartFromToolOutput(result.content[0].text, 'ok'), chart);
});

test('tiny accepted measurements produce finite geometry in every renderer without changing receipts', async () => {
  for (const { id, chart: original } of chartTemplates) {
    if (original.type === 'waffle') continue;
    for (const scale of [1e-24, 1e-300, Number.MIN_VALUE]) {
      const values = (items: (number | null)[]) => items.map(v => v === null ? null : v * scale);
      const chart = { ...original, series: original.series.map((s: { values: (number | null)[]; lowerValues?: (number | null)[]; upperValues?: (number | null)[] }) => ({ ...s,
        values: values(s.values), ...(s.lowerValues ? { lowerValues: values(s.lowerValues), upperValues: values(s.upperValues!) } : {}) })),
        ...(original.xValues ? { xValues: values(original.xValues) } : {}), ...(original.sizeValues ? { sizeValues: values(original.sizeValues) } : {}),
        ...(original.maxValue ? { maxValue: original.maxValue * scale } : {}) };
      // Decimal conservation can be lost during fixture scaling; use exact integer flow weights.
      if (chart.type === 'sankey') continue;
      const result = await tool.execute(chart, context);
      assert.deepEqual(chartFromToolOutput(result.content[0].text, 'ok'), chart);
      let markup;
      if (data.researchTypes.includes(chart.type)) {
        const engine = init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 400 });
        try { engine.setOption(researchOption(chart, 600)); markup = engine.renderToSVGString(); }
        finally { engine.dispose(); }
      } else {
        const { AnalysisChart } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/charts.js')).href);
        markup = renderToStaticMarkup(createElement(AnalysisChart, { chart }));
      }
      assert(!/NaN|Infinity/.test(markup), `${id} × ${scale} must not contain invalid geometry`);
    }
  }
});

test('narrow numeric ranges, independent scatter units and conserved tiny flows remain renderable', async () => {
  const histogram = chartTemplates.find((t: { chart: { type: string } }) => t.chart.type === 'histogram').chart;
  const cases = [[1e-10, 1e-10 + 1e-24], [1e-6, 1e-6 + 1e-21]].map(values => ({ ...histogram,
    categories: values.map((_, i) => String(i)), series: [{ name: '观测', values }] }));
  for (const value of [1e-300, Number.MIN_VALUE]) cases.push({ ...base, type: 'sankey', categories: ['A', 'B', 'C'],
    series: [{ name: 'A', values: [0, value, 0] }, { name: 'B', values: [0, 0, value] }] });
  for (const chart of cases) {
    const result = await tool.execute(chart, context);
    assert.deepEqual(chartFromToolOutput(result.content[0].text, 'ok'), chart);
    const engine = init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 400 });
    try { engine.setOption(researchOption(chart)); assert(!/NaN|Infinity/.test(engine.renderToSVGString())); }
    finally { engine.dispose(); }
  }
  const chart = { ...samples[1], unit: '%', xValues: [1e-100, 2e-100, 3e-100], series: [{ name: '甲', values: [1e-24, 2e-24, 3e-24] }] };
  const drawing = data.researchDrawing(chart);
  assert.equal(drawing.scales.length, 2);
  assert.equal(drawing.chart.xUnit, '× 1E-100 秒');
  assert.equal(drawing.chart.unit, '× 1E-24 %');
  assert.equal(data.differenceUnit(drawing.chart), '× 1E-24 百分点');
  assert.equal(chart.series[0].values[0], 1e-24, 'drawing never rewrites the original observations');
  const document = new JSDOM(renderToStaticMarkup(createElement(ResearchChart, { chart, width: 600 }))).window.document;
  assert.equal(document.querySelector('[data-chart-scale]')!.textContent, '数值 × 1E-24 % · 时间 × 1E-100 秒');
});

test('a one-row heatmap gives the data a readable cell height in the actual renderer', () => {
  const chart = { ...base, type: 'heatmap', categories: ['A组胜', 'B组胜', '双方均好', '双方均差'],
    unit: '场', series: [{ name: 'Fast', values: [4, 3, 12, 2] }] };
  const document = new JSDOM(renderToStaticMarkup(createElement(ResearchChart, { chart, width: 500 }))).window.document;
  const height = parseFloat(document.querySelector<HTMLElement>('[tabindex]')!.style.height);
  const engine = init(null, null, { renderer: 'svg', ssr: true, width: 500, height });
  try {
    engine.setOption(researchOption(chart, 500));
    const svg = new JSDOM(engine.renderToSVGString(), { contentType: 'image/svg+xml' }).window.document;
    const path = svg.querySelector('[ecmeta_series_index="0"][ecmeta_data_index="0"]')!.getAttribute('d')!;
    const cellHeight = Number(/l0 ([\d.]+)/.exec(path)![1]);
    assert(cellHeight >= 36, `actual matrix cell is only ${cellHeight}px high`);
    assert(height <= 110, 'one row does not need a tall canvas');
  } finally { engine.dispose(); }
});

test('all research charts pass the public tool contract and remain readable after serialization', async () => {
  for (const chart of samples) {
    const result = await tool.execute({ ...chart, references: [{ collectionId: "0_wencai/0_daily_eval", runId: 'test' }] }, context);
    assert.deepEqual(chartFromToolOutput(result.content[0].text, 'ok'), chart);
    const options = researchOption(chart, 514);
    assert(options.series.length > 0);
    assert.equal(options.animation, false);
    assert.equal(options.tooltip.show, false);
    assert.equal(options.tooltip.triggerOn, 'none');
  }
});

test('research chart geometry preserves unknown pairs, raw distribution counts and signed cumulative values', () => {
  const heatmap = researchOption(samples[0]);
  assert.equal(heatmap.series[0].data.length, 5, 'unknown is a missing cell; a recorded zero stays a cell');
  assert(heatmap.series[0].data.some((p: { value: number[] }) => p.value[2] === 0));
  assert.deepEqual(heatmap.series.at(-1).data[0], [2, 0]);
  assert.deepEqual(data.waterfallSteps(samples[2]).map((s: { start: number; end: number }) => [s.start, s.end]), [[0, 100], [100, -30], [-30, 10], [0, 10]]);
  for (const values of [[1, 1, 1], [-5, 0, 5, 10], [0, 0, 0, 1, 10]]) {
    const bins = data.histogramBins(values);
    assert.equal(bins.reduce((sum: number, bin: { count: number }) => sum + bin.count, 0), values.length);
    assert.equal(bins.at(-1).high, Math.max(...values));
  }
  assert.equal(data.decimalSum([0.1, 0.2]), 0.3);
  assert.equal(data.differenceUnit({ ...samples[0], unit: '%' }), '百分点');
  assert.equal(data.chartReading(samples[0], { sourceSeries: 1, categoryIndex: 1 }, 0), '乙 · B组：未知');
  assert.equal(data.chartReading(samples[1], { sourceSeries: 0, categoryIndex: 2 }, 0), '丙 · 时间：9 秒 · A组：30 次');
});

test('complete heatmaps place readable tier columns above the observed counts without a redundant colour scale', () => {
  const chart = { ...base, type: 'heatmap', categories: ['Fast', 'Expert'], series: [
    { name: 'A组胜', values: [54, 99] }, { name: 'B组胜', values: [94, 78] },
    { name: '双方都好', values: [61, 47] }, { name: '双方都差', values: [10, 11] },
  ] };
  const options = researchOption(chart, 246);
  assert.equal(options.xAxis.position, 'top');
  assert.deepEqual(options.xAxis.data, ['Fast', 'Expert']);
  assert.deepEqual(options.yAxis.data, chart.series.map(series => series.name));
  assert.equal(options.series[0].label.fontSize, 14);
  assert.equal(options.visualMap.show, false);
  assert.equal(options.series[0].data.length, 8);
  assert.deepEqual(options.series[0].data.map((point: { value: number[] }) => point.value[2]), [54, 99, 94, 78, 61, 47, 10, 11]);
  const document = new JSDOM(renderToStaticMarkup(createElement(ResearchChart, { chart, width: 246, english: false }))).window.document;
  assert(parseFloat(document.querySelector<HTMLElement>('[tabindex]')!.style.height) <= 205, 'four rows keep a compact canvas with readable cell heights');
  const narrow = new JSDOM(renderToStaticMarkup(createElement(ResearchChart, { chart, width: 199, english: false }))).window.document;
  assert.equal(parseFloat(narrow.querySelector<HTMLElement>('[tabindex]')!.style.width), 199, 'both tier columns fit a 320px conversation without shrinking labels');
  assert.equal(researchOption({ ...chart, series: chart.series.map((series, index) => index ? series : { ...series, values: [54, null] }) }).visualMap.show, true);
  const dense = { ...chart, categories: Array.from({ length: 13 }, (_, index) => String(index)), series: [{ name: '记录', values: Array(13).fill(1) }] };
  assert.equal(researchOption(dense).visualMap.show, true, 'a dense matrix with hidden numeric labels still keeps its colour scale');
});

test('battle denominators work in both matrix orientations without inventing cross-tier differences', () => {
  const chart = chartTemplates.find((template: { id: string }) => template.id === 'outcomes-tiers').chart;
  assert.deepEqual(data.battleTotals(chart), { axis: 'columns', totals: [166, 130], total: 296 });
  const transposed = { ...chart, categories: chart.series.map((s: { name: string }) => s.name),
    series: chart.categories.map((name: string, index: number) => ({ name, values: chart.series.map((s: { values: number[] }) => s.values[index]) })) };
  assert.deepEqual(data.battleTotals(transposed), { axis: 'rows', totals: [166, 130], total: 296 });
  assert.deepEqual(researchOption(transposed).yAxis.data, ['Fast', 'Expert']);
  assert.equal(data.battleTotals({ ...chart, series: chart.series.map((s: { name: string; values: number[] }) => ({ ...s, values: s.values.map(() => 0) })) }).total, 0);
  assert.equal(data.battleTotals({ ...chart, categories: ['Fast', 'FAST'] }), null, 'overlapping tier labels do not imply an additive total');
  assert.equal(data.battleTotals({ ...chart, categories: ['运行1', '运行2'] }), null, 'arbitrary datasets are not assumed disjoint');
  for (const value of [null, -1, .5]) {
    assert.equal(data.battleTotals({ ...chart, series: chart.series.map((s: { name: string; values: number[] }, index: number) => index ? s : { ...s, values: [value, 60] }) }), null);
  }
});

test('heatmaps preserve contrast and accessible readings without pointer tooltip text', () => {
  const chart = chartTemplates.find((template: { id: string }) => template.id === 'outcomes-tiers').chart;
  const option = researchOption(chart);
  assert.equal(option.tooltip.show, false);
  assert.equal(option.tooltip.triggerOn, 'none');
  const point = option.series[0].data[3];
  assert.equal(data.chartReading(chart, point, 3), 'Expert · B组胜：30 场 · 占本档 23.1%');
  assert.equal(option.series[0].emphasis.disabled, true, 'shared hover preserves the normal text colour and drawing order');
  assert.equal(option.series[0].emphasis.scale, false, 'the renderer does not add a second zoom');
  const missing = researchOption(samples[0]);
  assert.equal(data.chartReading(samples[0], missing.series[1].data[0], 0), '乙 · B组：未知');
});

test('invalid analytic shapes fail before source access', async () => {
  for (const chart of [
    { ...samples[1], xValues: [1, 2] },
    { ...samples[1], xValues: [1, null, 3] }, { ...samples[1], xLabel: '' },
    { ...samples[2], series: [{ name: 'A', values: [1, null, 2] }] },
    { ...samples[3], series: [...base.series, ...base.series] },
  ]) {
    await assert.rejects(tool.execute({ ...chart, references: [{ collectionId: "0_wencai/0_daily_eval", runId: 'test' }] }, context));
    assert.equal(chartFromToolOutput(JSON.stringify({ kind: 'chart', chart }), 'ok'), null);
  }
});

test('omitting an unsupported annotation produces a renderable receipt with the same observations', async () => {
  for (const annotation of [
    { categoryIndex: 1, seriesIndex: 1, note: '不存在的点' },
    { categoryIndex: 5, seriesIndex: 0, note: '越界' },
  ]) {
    const chart = { ...samples[0], annotations: [annotation] };
    const result = await tool.execute({ ...chart, references: [{ collectionId: "0_wencai/0_daily_eval", runId: 'test' }] }, context);
    const rendered = chartFromToolOutput(result.content[0].text!, 'ok');
    assert(rendered);
    assert.deepEqual(rendered.series, chart.series);
    assert.deepEqual(rendered.annotations, []);
    assert.equal(chartFromToolOutput(JSON.stringify({ kind: 'chart', chart }), 'ok'), null,
      'a malformed receipt must never put a label on the wrong observation');
  }
});

test('compact layers use observed quartiles and keep unknown differences unknown', () => {
  assert.equal(data.quantile([1, 2, 3, 4], .5), 2.5);
  assert.equal(data.quantile([1, 2, 3, 4], .25), 1.75);
  const matrix = researchOption(samples[0]);
  const delta = matrix.series.find((s: { data?: { derived?: string }[] }) => s.data?.[0]?.derived === 'difference');
  assert(delta);
  assert.deepEqual(data.pairedDifferences(samples[0]).map((p: { value: number | null }) => p.value), [-5, null, -30]);
  assert.equal(data.chartReading(samples[0], { derived: 'difference', categoryIndex: 1 }, 0), '乙 · B组 − A组：未知');
  const scatter = researchOption(samples[1]);
  assert.deepEqual(scatter.series[0].markLine.data, [{ xAxis: 4 }, { yAxis: 20 }]);
  const histogram = researchOption(samples[3]);
  assert.equal(histogram.xAxis.type, 'value');
  assert.equal(histogram.series[1].data.length, 3, 'the rug represents the original observations');
  assert.deepEqual(histogram.series[0].markArea.data, [[{ xAxis: 15 }, { xAxis: 25 }]]);
  assert(data.compactNumber(1e-9).includes('E-9'), 'compact annotations never round a small observation to zero');
});

test('every local template uses the current tool contract and the same receipt renderer', async () => {
  assert.equal(new Set(chartTemplates.map((t: { chart: { type: string } }) => t.chart.type)).size, 24);
  for (const { chart } of chartTemplates) {
    const result = await tool.execute({ ...chart, references: [{ collectionId: "0_wencai/0_daily_eval", runId: 'test' }] }, context);
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

test('zero-size bubble observations stay visible as zero labels without inventing bubble area', () => {
  const original = chartTemplates.find((t: { chart: { type: string } }) => t.chart.type === 'bubble').chart;
  const chart = { ...original, sizeValues: original.sizeValues.map(() => 0) };
  const option = researchOption(chart, 800);
  assert.equal(option.series[0].symbolSize([1, 2, 0]), 0);
  const engine = init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 400 });
  try {
    engine.setOption(option);
    assert(engine.renderToSVGString().includes(`${chart.sizeLabel}：0`), 'the plot must distinguish real zeros from an empty chart');
  } finally { engine.dispose(); }
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
    { ...example('interval'), series: [{ name: 'A', values: [2,3,4], lowerValues: [1,4,3], upperValues: [3,5,6] }] },
    { ...example('interval'), series: [{ name: 'A', values: [2,null,4], lowerValues: [1,2,3], upperValues: [3,4,6] }] },
    { ...example('violin'), categories: ['a','b','c','d','e'], series: [{ name: 'A', values: [1,2,3,4,5] }] },
  ];
  for (const chart of invalid) {
    await assert.rejects(tool.execute({ ...chart, references: [{ collectionId: "0_wencai/0_daily_eval", runId: 'test' }] }, context));
    assert.equal(chartFromToolOutput(JSON.stringify({ kind: 'chart', chart }), 'ok'), null, chart.type);
  }
});

test('circular and flow templates preserve area, units, hierarchy and empirical ranks', () => {
  assert.equal(roseRadius(0,20),18);
  assert(Math.abs((roseRadius(20,20)**2-18**2)/(roseRadius(10,20)**2-18**2)-2)<1e-10, 'rose area, not radius, tracks value');
  assert(data.decimalSumsEqual([.1,.2],[.3]));
  assert(!data.decimalSumsEqual([.1,.2],[.30000000000000004]));
  assert.deepEqual(data.empiricalCdf([2,1,2,null,4]), [{value:1,count:1,total:4,percent:25},{value:2,count:3,total:4,percent:75},{value:4,count:4,total:4,percent:100}]);
  const hierarchy=chartTemplates.find((t: {chart:{type:string}})=>t.chart.type==='sunburst').chart;
  assert.deepEqual(data.chartHierarchy(hierarchy).map((p: {value:number})=>p.value),[26,30,14]);
  const chord=chartTemplates.find((t: {chart:{type:string}})=>t.chart.type==='chord').chart;
  const arcs=chordArcs(chord);
  assert(Math.abs(arcs.reduce((sum:number,arc:{from:number;end:number})=>sum+arc.end-arc.from,0)+arcs.length*.08-2*Math.PI)<1e-10);
  assert.equal(data.chartLinks({categories:['A','B'],series:[{name:'A',values:[0,3]}]}).length,1);
});

test('new diagrams reject invented progress, invalid composition and impossible flows', async () => {
  const example=(type:string)=>chartTemplates.find((t:{chart:{type:string}})=>t.chart.type===type).chart;
  for (const chart of [
    {...example('rose'),series:[{name:'A',values:[1,2,-1,3,4,5]}]},
    {...example('concentric'),series:[{name:'A',values:[1,null,3]},{name:'B',values:[1,2,3]}]},
    {...example('radial_progress'),maxValue:80},
    {...example('radial_progress'),categories:['完成'],series:[{name:'进度',values:[82]}]},
    {...example('radar'),maxValue:0},
    {...example('waffle'),series:[{name:'样本',values:[1.5,2,3]}]},
    {...example('waffle'),series:[{name:'样本',values:[300,200,1]}]},
    {...example('sankey'),categories:['A','B','C'],series:[{name:'A',values:[0,3,0]},{name:'B',values:[0,0,2]}]},
    {...example('sankey'),categories:['A','B','C'],series:[{name:'A',values:[0,3,0]},{name:'B',values:[0,0,3]},{name:'C',values:[3,0,0]}]},
    {...example('chord'),categories:['A','B','C'],series:[{name:'A',values:[0,2,3]},{name:'B',values:[1,0,2]},{name:'C',values:[3,2,0]}]},
  ]) {
    await assert.rejects(tool.execute({...chart,references:[{ collectionId: "0_wencai/0_daily_eval",runId:'test'}]},context));
    assert.equal(chartFromToolOutput(JSON.stringify({kind:'chart',chart}),'ok'),null,chart.type);
  }
  const decimal={...example('sankey'),categories:['A','B','C','D'],series:[{name:'A',values:[0,.1,.2,0]},{name:'B',values:[0,0,0,.1]},{name:'C',values:[0,0,0,.2]}]};
  await tool.execute({...decimal,references:[{ collectionId: "0_wencai/0_daily_eval",runId:'test'}]},context);
});
