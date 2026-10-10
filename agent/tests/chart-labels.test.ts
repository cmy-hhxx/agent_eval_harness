import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { init } from 'echarts/core';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../../tests/fixtures/services.js';

const client = (file: string) => import(pathToFileURL(path.join(ROOT, 'agent/src/client', file)).href);
const { researchOption, ResearchChart } = await client('chart-research.js');
const { AnalysisChart } = await client('charts.js');
const { chartTemplates } = await client('chart-templates.js');
const { researchTypes, compactNumber, differenceUnit } = await client('chart-data.js');
const { researchLayout } = await client('chart-layout.js');
const { getBoundingRect } = await import(pathToFileURL(path.join(ROOT, 'node_modules/zrender/lib/contain/text.js')).href);
type Bounds = { text: string; x: number; y: number; width: number; height: number };

function assertSeparated(labels: Bounds[], context: string) {
  for (let i = 0; i < labels.length; i++) for (const b of labels.slice(i + 1)) {
    const a = labels[i];
    const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    assert(x < .5 || y < .5, `${context}: “${a.text}” overlaps “${b.text}” by ${x.toFixed(1)} × ${y.toFixed(1)} px`);
  }
}

function researchLabels(chart: typeof chartTemplates[number]['chart'], width: number) {
  const numbers = chart.series.flatMap((s: { values: (number | null)[]; lowerValues?: number[]; upperValues?: number[] }) => [...s.values, ...(s.lowerValues ?? []), ...(s.upperValues ?? [])]).filter((v: number | null) => v !== null).map(compactNumber);
  const layout = researchLayout(chart, width, differenceUnit(chart), numbers);
  const engine = init(null, null, { renderer: 'svg', ssr: true, width: layout.width, height: layout.height });
  try {
    engine.setOption(researchOption(chart, width));
    return engine.getZr().storage.getDisplayList().filter(el => el.type === 'tspan' && !el.ignore && !el.invisible).map(el => {
      const rect = el.getBoundingRect().clone();
      rect.applyTransform(el.transform);
      return { ...rect, text: String((el.style as { text: string }).text) };
    });
  } finally { engine.dispose(); }
}

function svgLabels(svg: Element): Bounds[] {
  return [...svg.querySelectorAll('text')].flatMap(text => {
    const size = Number(text.getAttribute('font-size') ?? 14);
    const anchor = text.getAttribute('text-anchor');
    const baseline = text.getAttribute('dominant-baseline');
    let y = Number(text.getAttribute('y') ?? 0);
    return [...(text.children.length ? text.children : [text])].map(line => {
      if (line !== text) y += Number(line.getAttribute('dy') ?? 0);
      const x = Number(line.getAttribute('x') ?? text.getAttribute('x') ?? 0);
      const label = line.textContent ?? '';
      const rect = getBoundingRect(label, `${size}px sans-serif`, anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left', ['middle', 'central'].includes(baseline ?? '') ? 'middle' : 'alphabetic');
      return { text: label, x: x + rect.x, y: y + rect.y, width: rect.width, height: rect.height };
    });
  });
}

test('every gallery template separates visible labels, axis ticks and annotations in its renderer', () => {
  for (const { id, chart } of chartTemplates) {
    if (researchTypes.includes(chart.type)) {
      for (const width of [418, 514, 680]) assertSeparated(researchLabels(chart, width), `${id} @ ${width}`);
    } else {
      const document = new JSDOM(renderToStaticMarkup(createElement(AnalysisChart, { chart }))).window.document;
      for (const svg of document.querySelectorAll('svg')) assertSeparated(svgLabels(svg), id);
    }
  }
});

test('slope endpoint labels all remain visible for identical, near and widely separated values', () => {
  const example = chartTemplates.find((t: { id: string }) => t.id === 'slope').chart;
  for (const values of [[72, 72, 72, 72], [0, .001, .002, 100], [-100, -99.999, -99.998, 0]]) {
    const chart = { ...example, series: ['A组', 'B组', 'C组', '参照'].map((name, i) => ({ name, values: [values[i], values[3 - i]] })) };
    const labels = researchLabels(chart, 514);
    assert.equal(labels.length, 10, 'all eight endpoint values and both stage names remain visible');
    assertSeparated(labels, `slope ${values}`);
  }
});

test('histogram statistics occupy a separate row from frequencies and retain their precise values', () => {
  const example = chartTemplates.find((t: { id: string }) => t.id === 'histogram').chart;
  for (const values of [[10, 11, 11, 12, 12, 12, 13, 13, 14, 14, 15, 17, 19, 20, 24, 31], [0, 0, 0, 0], [-1, 0, 1, 2]]) {
    const chart = { ...example, categories: values.map((_, i) => String(i)), series: [{ name: '观测', values }] };
    const option = researchOption(chart);
    assert.equal(option.series[0].markLine.label.show, false);
    assert.equal(option.series[0].markArea.label.show, false);
    const document = new JSDOM(renderToStaticMarkup(createElement(ResearchChart, { chart, width: 514 }))).window.document;
    assert.equal(document.querySelectorAll('[data-chart-statistics] > span').length, 2);
    if (values.length === 16) assert.equal(document.querySelector('[data-chart-statistics]')!.textContent, '中位数 13.5 秒Q1–Q3 12–17.5 秒');
    assertSeparated(researchLabels(chart, 514), `histogram ${values}`);
  }
});
