import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { ROOT } from "../../tests/fixtures/services.js";

const { AnalysisChart, chartFromToolOutput, chartsFromToolData, TurnCharts, TurnChartFallback } = await import(pathToFileURL(path.join(ROOT, "agent/src/client/charts.js")).href);
const { IgnoredChart } = await import(pathToFileURL(path.join(ROOT, "agent/src/client/inline-visuals.js")).href);
const { ComparisonDiagram, comparisonFromToolOutput } = await import(pathToFileURL(path.join(ROOT, "agent/src/client/comparison-diagram.js")).href);
const receipt = (chart: Record<string, unknown>) => JSON.stringify({ kind: "chart", chart });
const base = { title: "FAST 同档对战", scope: "已完成的 2 场 FAST 对战", unit: "场", source: "本次正式对比结果",
  categories: ["A 组胜", "B 组胜"], series: [{ name: "FAST", values: [1, 1] }] };
function render(chart: Record<string, unknown>) {
  const parsed = chartFromToolOutput(receipt(chart), "ok");
  assert(parsed, "fixture should satisfy the structured chart contract");
  return new JSDOM(renderToStaticMarkup(createElement(AnalysisChart, { chart: parsed }))).window.document;
}

test('complete battle matrices show the actual total while partial or non-additive data only shows its unit', () => {
  const chart = { ...base, type: 'heatmap', categories: ['Fast', 'Expert'], series: [
    { name: 'A组胜', values: [35, 60] }, { name: 'B组胜', values: [64, 30] },
    { name: '双方都好', values: [62, 37] }, { name: '双方都差', values: [5, 3] },
  ] };
  assert.equal(render(chart).querySelector('[data-chart-unit]')!.textContent, '合计 296 场');
  const partial = { ...chart, series: chart.series.map((s, i) => i ? s : { ...s, values: [35, null] }) };
  assert.equal(render(partial).querySelector('[data-chart-unit]')!.textContent, '单位：场');
  assert.equal(render({ ...chart, unit: '%' }).querySelector('[data-chart-unit]')!.textContent, '单位：%');
  assert.equal(render({ ...chart, series: chart.series.slice(0, 2) }).querySelector('[data-chart-unit]')!.textContent, '单位：场');
});

test('waffle uses a centered landscape grid with one equally sized cell per battle', () => {
  const document = render({ ...base, type: 'waffle', categories: ['B组胜', '双方答好', '双方答差', 'A组胜'], series: [{ name: '对局数', values: [60, 41, 5, 27] }] });
  const svg = document.querySelector('[data-chart-type=waffle]')!;
  const cells = [...svg.querySelectorAll('[data-waffle-cell]')];
  const width = Number(svg.getAttribute('width')), height = Number(svg.getAttribute('height'));
  const left = Math.min(...cells.map(cell => Number(cell.getAttribute('x'))));
  const right = Math.max(...cells.map(cell => Number(cell.getAttribute('x')) + Number(cell.getAttribute('width'))));
  assert.equal(cells.length, 133);
  assert.equal(new Set(cells.map(cell => cell.getAttribute('width'))).size, 1);
  assert(Math.abs(left - (width - right)) < 1, 'grid centered in its full plot');
  assert((right - left) / height > 1.6, 'avoid a tiny square in a wide figure');
  assert((right - left) / width > .7, 'grid uses the available card width');
});

test('a chart stands alone and its notes add only the supplied explanation', () => {
  const note = '缺少回款明细，尚不能解释差异';
  const document = render({ ...base, type: 'heatmap', categories: ['营收', '现金流'],
    series: [{ name: 'A组', values: [4, 1] }, { name: 'B组', values: [3, 7] }],
    annotations: [{ categoryIndex: 1, seriesIndex: 1, note }] });
  assert.equal(document.querySelectorAll('[data-chart-actions], table, [data-chart-summary]').length, 0,
    'the figure has no table view, switch or automatic repetition of the largest difference');
  assert.equal(document.querySelector('[data-chart-annotations] li')!.textContent, note,
    'the numbered note does not repeat the category, series, value or unit');
  assert.equal(document.querySelector<HTMLElement>('[data-chart-annotations]')!.style.fontSize, '14px', 'necessary annotations remain readable without small print');
});

test("line chart uses elapsed time and breaks paths at missing values", () => {
  const document = render({ ...base, type: "line", unit: "条", categories: ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-11", "2026-01-21"],
    series: [{ name: "已完成", values: [0, 1, null, 4, 8] }] });
  const points = [...document.querySelectorAll("[data-chart-mark=point]")];
  assert.equal(points.length, 4);
  const positions = points.map(node => Number(node.getAttribute("cx")));
  const day = positions[1] - positions[0], tenDays = positions[3] - positions[2];
  assert(Math.abs(tenDays / day - 10) < 0.001, "dates are positioned by real elapsed days, not category index");
  const segments = [...document.querySelectorAll("[data-chart-mark=line]")];
  assert.equal(segments.length, 2, "null splits the line into two independently drawn paths");
  assert(segments.every(node => node.getAttribute("points")!.split(" ").length === 2));
  const missingRow = [...document.querySelectorAll("[data-chart-accessible-data] > div")].find(node => node.textContent!.includes("2026-01-03"));
  assert.equal(missingRow!.querySelector("dd")!.textContent, "已完成：未知 条");
  const decimal = render({ ...base, type: "line", categories: ["2024", "2026"], series: [{ name: "实际值", values: [1.1, 1.6] }] });
  assert.deepEqual([...decimal.querySelectorAll('[data-axis-tick]')].map(node => node.textContent), ['1', '1.2', '1.4', '1.6'], 'decimal ticks use readable increments in the actual unit');
});

test("pie chart exposes percentage, actual values and the denominator including zero categories", () => {
  const document = render({ ...base, type: "pie", categories: ["A 组胜", "B 组胜", "双方均好"], series: [{ name: "FAST", values: [1, 3, 0] }] });
  assert.equal(document.querySelectorAll("[data-chart-mark=wedge]").length, 2);
  const quarters = [...document.querySelectorAll('[data-chart-mark=wedge]')];
  assert.equal(quarters[0].tagName.toLowerCase(), 'path', 'composition geometry uses ring sectors rather than browser stroke dashes');
  assert.equal(quarters[0].getAttribute('d'), 'M 100 8 A 92 92 0 0 1 192 100 L 164 100 A 64 64 0 0 0 100 36 Z', 'one quarter has concentric outer/inner arcs and straight radial boundaries');
  assert.equal(quarters[1].getAttribute('d'), 'M 192 100 A 92 92 0 0 1 34.946 165.054 A 92 92 0 0 1 100 8 L 100 36 A 64 64 0 0 0 54.745 145.255 A 64 64 0 0 0 164 100 Z', 'two concentric arcs share the exact radial boundaries without a gap or notch');
  assert.deepEqual([...document.querySelectorAll('[data-chart-composition-value]')].map(node => node.textContent), ['1', '3', '0']);
  assert.deepEqual([...document.querySelectorAll('[data-chart-share]')].map(node => node.textContent), ['25%', '75%', '0%']);
  assert.equal(document.querySelector('[data-chart-total]')!.textContent, '4');
  assert.equal(document.querySelectorAll('[data-chart-denominator]').length, 1, 'the visible composition states its total once rather than repeating the denominator in each row');
  assert.match(document.querySelector('ul li:last-child')!.textContent!, /双方均好/);
  assert.match(document.querySelector("[data-chart-accessible-data]")!.textContent!, /25% \(1\/4\)/);
  assert.equal(document.querySelectorAll("[data-chart-accessible-data] > div").length, 3);
  const single = render({ ...base, type: "pie", categories: ["A 组胜"], series: [{ name: "FAST", values: [2] }] });
  const fullRing = single.querySelector("path[data-chart-mark=wedge]")!;
  assert.equal(fullRing.getAttribute('fill-rule'), 'evenodd', 'a 100% share retains the open centre for the total');
  assert.equal((fullRing.getAttribute('d')!.match(/ A /g) ?? []).length, 4, 'a full ring uses two complete circles built from four half-circle arcs');
  assert.equal((fullRing.getAttribute('d')!.match(/M /g) ?? []).length, 2);
  assert.equal(fullRing.hasAttribute('stroke-dasharray'), false);
  const rounded = render({ ...base, type: "pie", scope: "已裁决的 11 场 FAST 对战", series: [{ name: "FAST", values: [6, 5] }] });
  assert.equal(rounded.querySelector('[data-chart-share]')!.textContent, '54.55%');
  assert.equal(rounded.querySelector('[data-chart-composition-value]')!.textContent, '6');
  assert.equal(rounded.querySelector('[data-chart-total]')!.textContent, '11');
  assert.match(rounded.querySelector('[data-chart-accessible-data]')!.textContent!, /54.55% \(6\/11\)/);
  const small = render({ ...base, type: "pie", series: [{ name: "FAST", values: [1e-9, 1] }] });
  assert.match(small.querySelector('ul li')!.textContent!, /<0.01%/);
});

test("chart metadata and accessible observations remain text without executing supplied HTML", () => {
  const attack = '<script>alert(1)</script><img src="https://untrusted.example/pixel" onerror="alert(1)">';
  const document = render({ ...base, type: "heatmap", title: attack, scope: attack, source: attack,
    categories: [attack, "B 组"], series: [{ name: attack, values: [2, 1] }] });
  assert.equal(document.querySelectorAll("script,img,a,iframe").length, 0);
  assert.equal(document.querySelector("h3")!.textContent, attack);
  assert(document.querySelector("figcaption")!.textContent!.includes(attack));
  assert.equal(document.querySelector('[data-chart-unit]')!.textContent, '单位：场');
  assert.match(document.querySelector("figure")!.textContent!, /来源：/);
  assert.equal(document.querySelectorAll('[data-chart-actions], table').length, 0);
  const accessibleContainer = document.querySelector<HTMLElement>('[data-chart-accessible-data]')!;
  assert.equal(accessibleContainer.style.position, 'absolute');
  assert.equal(accessibleContainer.style.width, '1px', 'exact observations do not duplicate the visible chart');
  assert.equal(accessibleContainer.style.overflow, 'hidden');
  assert.equal(accessibleContainer.style.clipPath, 'inset(50%)');
  assert.equal(accessibleContainer.hasAttribute('aria-hidden'), false);
  assert.equal(accessibleContainer.querySelectorAll('dt').length, 2);
  assert.equal(accessibleContainer.querySelectorAll('dd').length, 2);
  assert.equal(document.querySelector('[data-chart-legend]'), null, 'a single series does not repeat a redundant legend');
  assert.equal(document.querySelector('footer'), null, 'source descriptions do not add visible small print');
  assert.equal(document.querySelector('[data-chart-scope]')!.textContent, attack);
  assert.equal(document.querySelector('[data-chart-metadata]')!.textContent, `来源：${attack}`);
  assert.equal(document.querySelectorAll('svg title').length, 0, 'charts expose accessible names without browser hover text');
});

test('chart faces show the scope once while source remains accessible metadata', () => {
  const composition = render({ ...base, type: 'pie', title: '17 次运行中 6 次完成', scope: '17 次运行的当前状态',
    categories: ['已完成', '中断'], series: [{ name: '运行', values: [6, 11] }] });
  const ring = composition.querySelector('svg')!;
  assert(Number(ring.getAttribute('width')) <= 144 && Number(ring.getAttribute('height')) <= 144, 'a two-category summary does not occupy a large plot');
  assert.equal(composition.querySelector('[data-chart-total]')!.textContent, '17');
  assert.deepEqual([...composition.querySelectorAll('[data-chart-composition-value]')].map(node => node.textContent), ['6', '11']);
  assert.deepEqual([...composition.querySelectorAll('[data-chart-share]')].map(node => node.textContent), ['35.29%', '64.71%']);
  assert.equal(composition.querySelector('figcaption')!.textContent, '17 次运行中 6 次完成单位：场');
  const metadata = composition.querySelector<HTMLElement>('[data-chart-metadata]')!;
  assert.equal(composition.querySelector('[data-chart-scope]')!.textContent, '17 次运行的当前状态');
  assert.equal(metadata.textContent, `来源：${base.source}`);
  assert.equal(metadata.style.clipPath, 'inset(50%)');
  assert.equal(metadata.hasAttribute('aria-hidden'), false, 'scope and source remain available to assistive readers');
  assert.equal(composition.querySelector('footer'), null);
  const wideTotal = render({ ...base, type: 'pie', series: [{ name: '数量', values: [60000, 60000] }] });
  const total = wideTotal.querySelector('[data-chart-total]')!;
  assert.equal(total.textContent, '120,000');
  assert.equal(total.closest('[data-chart-denominator]'), null, 'even a six-digit total moves below the smaller ring when it would collide with its centre');
  assert.match(wideTotal.querySelector('[data-chart-accessible-data]')!.textContent!, /50% \(60,000\/120,000\)/);
});

test('saved chart captions show data dates and sample counts without evaluator timestamps', () => {
  const scope = '批次 2026-10-11 · 阶段结果 · 评测自 2026-10-12 01:03（结束未登记，北京时间）· 结果截至 2026-10-12 09:18（北京时间）· 正式样本：Fast 278场、Expert 270场';
  const document = render({ ...base, type: 'heatmap', scope });
  assert.equal(document.querySelector('[data-chart-scope]')!.textContent, '2026-10-11 · Fast 278场、Expert 270场');
  assert.equal(document.querySelector('[data-chart-full-scope]'), null);
  assert.doesNotMatch(document.body.textContent!, /评测自|阶段结果|结果截至|北京时间|01:03/);
  assert.doesNotMatch(document.body.innerHTML, /评测自|结果截至|01:03|09:18/, "accessible chart labels use the same compact data dates");
  const matrix = render({ ...base, type: 'heatmap', scope, categories: ['Fast', 'Expert'], series: [
    { name: 'A组胜', values: [71, 110] }, { name: 'B组胜', values: [96, 69] },
    { name: '双方都好', values: [101, 86] }, { name: '双方都差', values: [10, 5] },
  ] });
  assert.equal(matrix.querySelector('[data-chart-scope]')!.textContent, '2026-10-11 · Fast 278场、Expert 270场');
  const custom = '2026-10-11 · 仅核对三道题';
  assert.equal(render({ ...base, type: 'heatmap', scope: custom }).querySelector('[data-chart-scope]')!.textContent, custom);
});

test('trend labels show the last known value, avoid coincident tails and retain every observation', () => {
  const categories = Array.from({ length: 30 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}`);
  const document = render({ ...base, type: 'line', categories, series: ['A组', 'B组', 'C组', '参照'].map((name, index) => ({ name, values: Array.from({ length: 30 }, (_, day) => index === 3 && day === 29 ? null : day === 29 ? 5 : day === 28 && index === 3 ? 5 : day / 10) })) });
  assert.equal(document.querySelectorAll('[data-chart-mark=point]').length, 119);
  const labels = [...document.querySelectorAll('[data-chart-value]')];
  assert.equal(labels.length, 4, 'dense trends label each last known value instead of every point');
  assert.equal(new Set(labels.map(node => node.getAttribute('y'))).size, 4, 'coincident endpoints receive distinct tail label rows');
  assert(labels.every(node => node.textContent === '5'));
  assert.deepEqual([...document.querySelectorAll('[data-chart-tail-name]')].map(node => node.textContent), ['A组', 'B组', 'C组', '参照']);
  assert.equal(document.querySelector('[data-chart-legend]'), null, 'direct model labels remove the trend legend lookup');
  const missingTail = document.querySelector('[data-chart-value][data-series="参照"]')!;
  const lastPoint = [...document.querySelectorAll('[data-chart-mark=point][data-series="参照"]')].at(-1)!;
  assert.equal(missingTail.getAttribute('data-endpoint-x'), lastPoint.getAttribute('cx'), 'the leader starts at the last known date, not the missing last date');
  assert(document.querySelectorAll('[data-chart-label=date]').length < 10, 'date labels do not crowd all thirty observations');
  assert.equal(document.querySelectorAll('[data-chart-accessible-data] > div').length, 30);
});

test('composition colours remain tied to identities and outcomes when categories are reordered', () => {
  const categories = ['A组胜', 'B组胜', 'C组胜', '双方均好', '双方均差', '待定'];
  const fills = (names: string[]) => {
    const document = render({ ...base, type: 'pie', categories: names, series: [{ name: '对战结果', values: names.map(() => 1) }] });
    return new Map([...document.querySelectorAll('[data-chart-mark=wedge]')].map(mark => [mark.getAttribute('data-category'), mark.getAttribute('fill')]));
  };
  const original = fills(categories), reordered = fills(categories.toReversed());
  for (const category of categories) assert.equal(original.get(category), reordered.get(category));
  assert.equal(new Set(original.values()).size, categories.length, 'winner identities and both-good/both-bad results have distinct colours');
  const generic = fills(['证据缺失', '口径混用', '计算错误']), genericReordered = fills(['计算错误', '证据缺失', '口径混用']);
  for (const [category, colour] of generic) assert.equal(colour, genericReordered.get(category), 'generic categories retain their colour for the same set, independent of input order');
});

test('small composition sectors keep their real angle without a divider erasing them', () => {
  const document = render({ ...base, type: 'pie', series: [{ name: 'FAST', values: [999, 1] }] });
  const wedges = [...document.querySelectorAll('[data-chart-mark=wedge]')];
  assert(wedges.every(wedge => wedge.getAttribute('stroke-width') === '0'), 'neighbouring white strokes cannot cover the tiny slice');
  const geometry = /M ([\d.]+) ([\d.]+) A 92 92 0 0 1 ([\d.]+) ([\d.]+)/.exec(wedges[1].getAttribute('d')!)!;
  assert(geometry);
  const [startX, startY, endX, endY] = geometry.slice(1).map(Number);
  const chord = Math.hypot(endX - startX, endY - startY);
  assert(Math.abs(chord - 2 * 92 * Math.sin(Math.PI / 1000)) < .001, '0.1% retains its true geometric size instead of a fabricated minimum angle');
  assert.equal(document.querySelectorAll('[data-chart-share]')[1].textContent, '0.1%');
  const large = render({ ...base, type: 'pie' });
  assert.equal(large.querySelector('[data-chart-mark=wedge]')!.getAttribute('stroke-width'), '1.5', 'ordinary sectors keep the restrained divider');
  const nearComplete = render({ ...base, type: 'pie', series: [{ name: 'FAST', values: [1e15, 1] }] });
  const dominant = nearComplete.querySelector('[data-chart-mark=wedge]')!.getAttribute('d')!;
  assert.equal((dominant.match(/ A /g) ?? []).length, 4, 'a near-complete ring is split into two outer and two inner arcs, rather than a collapsed full-circle arc');
  assert(dominant.includes('100 192'), 'the dominant sector still reaches the bottom of the ring when radial edges round together');
});

test('short narrow trends fit the first screen and preserve the complete calendar coordinates', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 230 });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    for (const categories of [['2026-01-01', '2026-01-21'], ['2025-12-31', '2026-01-01']]) {
      await act(async () => { root.render(createElement(AnalysisChart, { chart: { ...base, type: 'line', categories,
        series: [{ name: 'B组Fast', values: [1.1, 1.5] }, { name: 'A组Fast', values: [1.25, 1.6] }] } })); });
      const document = dom.window.document;
      const plotWidth = Number(document.querySelector('svg')!.getAttribute('width'));
      assert(plotWidth > 0 && plotWidth <= 230, 'ordinary values and dates fit the viewport including chart padding');
      assert.deepEqual([...document.querySelectorAll('[data-chart-label=date]')].map(label => label.getAttribute('data-date')), categories);
      assert.deepEqual([...document.querySelectorAll('[data-chart-tail-name]')].map(label => label.textContent), ['B组Fast', 'A组Fast']);
      assert.deepEqual([...document.querySelectorAll('[data-chart-tails] [data-chart-value]')].map(label => label.textContent), ['1.5', '1.6']);
      assert.equal(document.querySelectorAll('[data-chart-accessible-data] > div').length, 2);
    }
    const names = ['C组', 'A组', '参照', 'B组'];
    await act(async () => { root.render(createElement(AnalysisChart, { chart: { ...base, type: 'line', categories: ['2026-01-01', '2026-01-21'],
      series: names.map((name, index) => ({ name, values: [index + 1, index + 2] })) } })); });
    const cLine = dom.window.document.querySelector('[data-chart-mark=line][data-series="C组"]')!;
    assert.equal(cLine.getAttribute('stroke-dasharray'), '6 4', 'an explicit C identity retains its dash pattern after reordering');
    const cSwatch = dom.window.document.querySelector<HTMLElement>('[data-chart-tail-name][data-series="C组"] > span')!;
    assert.equal(cSwatch.style.borderTopStyle, 'dashed', 'the direct-label swatch agrees with the actual C line');
    const lines = [...dom.window.document.querySelectorAll('[data-chart-mark=line]')];
    assert.equal(new Set(lines.map(line => line.getAttribute('stroke'))).size, 4, 'an unlabelled reference series never steals an explicit identity colour');
    assert.equal(new Set(lines.map(line => line.getAttribute('stroke-dasharray') ?? 'solid')).size, 3, 'four series add dashed and dotted strokes to the two distinct solid identity colours');
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(globalThis, previous); dom.window.close();
  }
});

test('a trend retains exact scientific labels and keyboard readings without floating pointer text', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 230 });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    const value = 1.2345678901234567e-9;
    const chart = { ...base, type: 'line', unit: '示例值', categories: ['2026-01-01', '2026-01-21'], series: [{ name: 'A组Fast', values: [1e-9, value] }] };
    await act(async () => { root.render(createElement(AnalysisChart, { chart })); });
    const svg = dom.window.document.querySelector('svg')!;
    const label = dom.window.document.querySelector('[data-chart-value]')!;
    assert(Number(svg.getAttribute('width')) > 230, 'a narrow trend keeps a sufficient independent scroll area');
    assert.equal(svg.style.maxWidth, '', 'the SVG does not scale its pixel labels down to the narrow container');
    assert.equal(Number(label.textContent), value, 'the scientific label round-trips the recorded JS number');
    assert.equal((label as HTMLElement).style.fontSize, '15px');
    assert(label.closest('[data-chart-tails]'), 'the precise last value stays below the scroll area on narrow screens');
    assert.equal(label.closest('svg'), null, 'tail text never needs a horizontal scroll to become available');
    Object.defineProperty(svg, 'getBoundingClientRect', { value: () => new dom.window.DOMRect(0, 0, Number(svg.getAttribute('width')), Number(svg.getAttribute('height'))) });
    const targets = [...dom.window.document.querySelectorAll<SVGElement>('[data-chart-hit]')];
    assert(targets.every(target => target.getAttribute('tabindex') === '0' && Number(target.getAttribute('r')) >= 22), 'exact readings have keyboard and 44px pointer targets');
    const readout = dom.window.document.querySelector<HTMLElement>('[data-chart-readout]')!;
    assert.equal(readout.style.clipPath, 'inset(50%)');
    assert.equal(readout.style.position, 'absolute', 'inactive point readings reserve no empty row under the plot');
    await act(async () => { targets[1].focus(); });
    assert.equal(readout.style.clipPath, 'inset(50%)', 'keyboard readings stay in the accessibility tree without a floating label');
    assert.equal(readout.textContent, `2026-01-21 · A组Fast · ${label.textContent} 示例值`);
    await act(async () => { targets[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(readout.textContent, '', 'Escape clears the auxiliary reading');
    await act(async () => { targets[0].dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true,
      clientX: Number(targets[0].getAttribute('cx')), clientY: Number(targets[0].getAttribute('cy')) })); });
    assert.equal(readout.textContent, '', 'pointer clicks do not create a text readout');
    const collision = { ...base, type: 'line', categories: ['2026-01-01', '2026-01-02', '2026-01-21'],
      series: [{ name: 'A组', values: [1.05, 1.05, 2] }, { name: 'B组', values: [1, 1, 2] }] };
    await act(async () => { root.render(createElement(AnalysisChart, { chart: collision })); });
    const first = dom.window.document.querySelector<SVGElement>('[data-chart-hit][data-series="A组"][data-date="2026-01-01"]')!;
    await act(async () => { first.focus(); });
    assert.equal(readout.textContent, '2026-01-01 · A组 · 1.05 场');
    const last = dom.window.document.querySelector<SVGElement>('[data-chart-hit][data-series="B组"][data-date="2026-01-21"]')!;
    await act(async () => { last.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true,
      clientX: Number(last.getAttribute('cx')), clientY: Number(last.getAttribute('cy')) })); });
    assert.equal(readout.textContent, '2026-01-01 · A组 · 1.05 场', 'hover does not change or open point text');
    await act(async () => { last.focus(); });
    assert.equal(readout.textContent, '2026-01-21 · A组 · 2 场 / B组 · 2 场', 'keyboard focus also exposes both coincident observations');
    const precise = 0.0000010000000000000002;
    await act(async () => { root.render(createElement(AnalysisChart, { chart: { ...base, type: 'line', categories: ['2026-01-01', '2026-01-21'], series: [{ name: 'A组', values: [1e-6, precise] }] } })); });
    const precisePoint = dom.window.document.querySelector<SVGElement>('[data-chart-hit][data-date="2026-01-21"]')!;
    await act(async () => { precisePoint.focus(); });
    const exactText = dom.window.document.querySelector('[data-chart-value]')!.textContent!;
    assert.equal(Number(exactText), precise, 'ordinary-format precision loss falls back to a round-tripping scientific value');
    assert.equal(dom.window.document.querySelector('[data-chart-accessible-data] > div:last-child dd')!.textContent, `A组：${exactText} 场`);
    assert.equal(readout.textContent, `2026-01-21 · A组 · ${exactText} 场`, 'plot labels, accessible observations and exact point reading agree');
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(globalThis, previous); dom.window.close();
  }
});

test('nearby representable line values retain finite geometry within the plot and distinct ticks', () => {
  for (const values of [[1e15, 1e15 - 0.125], [1, 1.0000000000000002], [1e-6, 1.0000000000000002e-6]]) {
    for (const sign of [1, -1]) {
      const document = render({ ...base, type: 'line', categories: ['2026-01-01', '2026-01-21'], series: [{ name: '实际值', values: values.map(value => value * sign) }] });
      const points = [...document.querySelectorAll('[data-chart-mark=point]')];
      for (const point of points) {
        const y = Number(point.getAttribute('cy'));
        assert(Number.isFinite(y) && y >= 22 && y <= 190, 'a sub-ULP alignment never collapses the domain or moves a recorded point outside the compact plot');
      }
      assert.notEqual(points[0].getAttribute('cy'), points[1].getAttribute('cy'), 'distinct stored numbers remain distinct positions');
      const ticks = [...document.querySelectorAll('[data-axis-tick]')].map(node => node.textContent);
      assert.equal(new Set(ticks).size, ticks.length, 'cleanup never turns nearby ticks into duplicate values');
      assert(ticks.length >= 2);
    }
  }
});

test("chart receipts do not render failed, incomplete, unsafe or invalid data", () => {
  for (const state of ["preparing", "running", "error", "stopped"]) assert.equal(chartFromToolOutput(receipt({ ...base, type: "heatmap" }), state), null);
  for (const output of ["", "not JSON", JSON.stringify({ chart: { ...base, type: "heatmap" } }), JSON.stringify({ kind: "chart", html: "<script/>" })])
    assert.equal(chartFromToolOutput(output, "ok"), null);
  const invalid = [
    { ...base, type: "html" }, { ...base, type: "heatmap", series: [{ name: "FAST", values: [1] }] },
    { ...base, type: "heatmap", series: [{ name: "FAST", values: [1, "2"] }] },
    { ...base, type: "pie", series: [{ name: "FAST", values: [0, 0] }] },
    { ...base, type: "pie", series: [{ name: "FAST", values: [1, -1] }] },
    { ...base, type: "pie", categories: Array.from({ length: 7 }, (_, index) => String(index)), series: [{ name: "FAST", values: Array(7).fill(1) }] },
    { ...base, type: "line", categories: ["2026-01-02", "2026-01-01"] },
    { ...base, type: "line", categories: ["2026-01-01", "2026-01-01"] },
    { ...base, type: "line", categories: ["FAST", "Expert"] },
    { ...base, type: "line", categories: ["2026-02-30", "2026-03-04"] },
    { ...base, type: "heatmap", series: [{ name: "FAST", values: [null, null] }] },
    { ...base, type: "heatmap", series: [{ name: "FAST", values: [1, 2] }, { name: "FAST", values: [3, 4] }] },
    { ...base, type: "heatmap", series: [{ name: "FAST", values: [1e16, 2] }] },
  ];
  for (const chart of invalid) assert.equal(chartFromToolOutput(receipt(chart), "ok"), null);
  assert.equal(chartFromToolOutput('{"kind":"chart","chart":{"type":"heatmap","title":"x","scope":"x","unit":"x","source":"x","categories":["x"],"series":[{"name":"x","values":[1e400]}]}}', "ok"), null);
});

test("small nonzero chart values retain their magnitude instead of rounding to zero", () => {
  const document = render({ ...base, type: "line", categories: ["2025", "2026"], series: [{ name: "变化", values: [1e-9, -1e-9] }] });
  const labels = [...document.querySelectorAll("[data-chart-value]")].map(node => node.textContent);
  assert(labels.every(value => value!.includes("E-9")));
  assert.equal(document.querySelectorAll('[data-value="0"]').length, 0);
});

test("calendar labels support the server's year and month coordinates and retain an unknown series", () => {
  for (const categories of [["2024", "2026"], ["2026-01", "2026-03"]]) {
    const document = render({ ...base, type: "line", categories,
      series: [{ name: "已知", values: [1, 2] }, { name: "未知系列", values: [null, null] }] });
    assert.equal(document.querySelectorAll('[data-chart-mark=point]').length, 2);
    assert(document.querySelector('[data-chart-accessible-data]')!.textContent!.includes('未知系列'));
    assert.equal(document.querySelectorAll('[data-chart-mark=point][data-series="未知系列"]').length, 0);
    assert.equal(document.querySelector('[data-chart-no-values]')!.textContent, '未知系列：未知', 'a wholly missing series stays visible outside the accessible description');
  }
});

test("completed-Turn charts use accepted results, deduplicate call identities and ignore failures and arguments", () => {
  const chart = { ...base, type: "heatmap" };
  const accepted = { kind: "tool-result", callId: "chart-one", call: { name: "show_chart", argsRaw: JSON.stringify({ ...chart, series: [{ name: "FAST", values: [100, 0] }] }) },
    content: [{ type: "text", text: receipt(chart) }], isError: false, subCalls: [] };
  const data = [
    { root: accepted }, { root: accepted },
    { root: { ...accepted, callId: "failed-chart", isError: true } },
    { root: { ...accepted, callId: "different-tool", call: { name: "read_data" } } },
    { root: { phase: "start", name: "show_chart", callId: "preparing-chart", argsRaw: receipt(chart), subCalls: [] } },
    { root: { kind: "tool-result", callId: "parent", call: { name: "call_specialist" }, content: [], isError: false,
      subCalls: [{ ...accepted, callId: "chart-two", content: [{ type: "text", text: receipt(chart) }] }] } },
  ];
  const results = chartsFromToolData(data);
  assert.deepEqual(results.map((entry: { callId: string }) => entry.callId), ["chart-one", "chart-two"]);
  assert.deepEqual(results[0].chart.series[0].values, [1, 1], "arguments cannot replace the recorded receipt values");
  assert.deepEqual(chartsFromToolData([{ root: { ...accepted, content: [{ type: "text", text: "invalid receipt" }] } }]),
    [{ callId: 'chart-one', error: '图表数据无效，无法显示' }], 'a corrupt successful receipt must not silently disappear');
});

test("response charts read only their Turn's accepted receipts without a Markdown reference", () => {
  const data = [{ root: { kind: "tool-result", callId: "chart-one", call: { name: "show_chart" }, isError: false,
    content: [{ type: "text", text: receipt({ ...base, type: "heatmap" }) }], subCalls: [] } }];
  const requests: unknown[] = [];
  const nodes = { turnDataSource(turn: number, kind: string) {
    requests.push([turn, kind]);
    return { getSnapshot: () => turn === 7 && kind === 'tool-call' ? data : [], subscribe: () => () => {} };
  } };
  const useChat = (select: (snapshot: unknown) => unknown) => select({ nodes });
  const document = new JSDOM(renderToStaticMarkup(createElement(TurnCharts, { turn: 7, useChat }))).window.document;
  assert.deepEqual(requests, [[7, "tool-call"]]);
  assert.equal(document.querySelectorAll('[data-turn-charts="7"] figure').length, 1);
  assert.equal(document.querySelectorAll('[data-step-process], [data-tool]').length, 0);
  assert.equal(renderToStaticMarkup(createElement(TurnCharts, { turn: 8, useChat })), '', 'another turn cannot display these receipts');
});

test('accepted charts stay at the tail only when cancellation or failure leaves no final answer', () => {
  const data = [{ root: { kind: 'tool-result', callId: 'chart-one', call: { name: 'show_chart' }, isError: false,
    content: [{ type: 'text', text: receipt({ ...base, type: 'heatmap' }) }], subCalls: [] } }];
  const processes = [{ answerStep: null as number | null }];
  const nodes = { turnDataSource(turn: number, kind: string) {
    assert.equal(turn, 7);
    assert(['tool-call', 'turn-process'].includes(kind), 'placement never reads or parses answer text');
    return { getSnapshot: () => kind === 'tool-call' ? data : processes, subscribe: () => () => {} };
  } };
  const useChat = (select: (snapshot: unknown) => unknown) => select({ nodes });
  const tail = () => new JSDOM(renderToStaticMarkup(createElement(TurnChartFallback, { turn: { turn: 7 }, useChat }))).window.document;
  assert.equal(tail().querySelectorAll('[data-turn-chart-fallback] figure').length, 1);
  processes[0].answerStep = 2;
  assert.equal(tail().querySelectorAll('figure').length, 0, 'a final answer owns the charts, with no duplicate at the tail');
});

test('chart fences are empty placeholders even when a real answer mistypes or repeats a chart identifier', () => {
  for (const code of ['', '5eece766-4811-4742-b81c-a3411b3e926e', 'first\nsecond', '<script>run()</script>']) {
    for (const streaming of [false, true]) assert.equal(renderToStaticMarkup(createElement(IgnoredChart, { code, streaming })), '');
  }
});

const comparison = {
  title: '中国船舶当前的 EMA20 是多少',
  candidates: [
    { model: 'b_expert', name: 'B组Expert', outcome: 'both_good', summary: '给出9月30日 EMA20 为38.192元。', paths: [
      { title: '核心数值', evidence: 'B给出9月30日 EMA20 为38.192元', impact: '数值可直接使用', assessment: 'strength' },
    ] },
    { model: 'a_expert', name: 'A组Expert', outcome: 'both_good', summary: '给出9月30日 EMA20 为38.192元。', paths: [
      { title: '核心数值', evidence: 'A给出同一日期 EMA20 为38.192元', impact: '核心数值可用', assessment: 'strength' },
      { title: '日期口径', evidence: '当前口径缺少核验，A沿用9月30日数据', impact: '不能确认当前时点适用', assessment: 'uncertain' },
    ] },
  ],
  verdict: '双方均好', reason: '数值与数据日期相同', caveat: '对比口径：9月30日 EMA20',
};
const comparisonReceipt = (diagram: Record<string, unknown>) => JSON.stringify({ kind: 'comparison-diagram', diagram });

test('comparison receipts separate question, answers and usefulness without pairing independent branches', () => {
  const parsed = comparisonFromToolOutput(comparisonReceipt(comparison), 'ok');
  assert.deepEqual(parsed, comparison);
  const document = new JSDOM(renderToStaticMarkup(createElement(ComparisonDiagram, { diagram: parsed }))).window.document;
  assert.equal(document.querySelector('[data-comparison-question]')!.textContent, comparison.title);
  assert.deepEqual([...document.querySelectorAll('[data-comparison-slice]')].map(node => node.getAttribute('data-comparison-slice')), ['question', 'answer', 'usefulness']);
  assert.deepEqual([...document.querySelectorAll('[data-comparison-slice-title]')].map(node => node.textContent), ['用户问了什么', '回答给了什么', '对用户有什么用']);
  assert.deepEqual([...document.querySelectorAll('[data-comparison-name]')].map(node => [node.getAttribute('data-comparison-name'), node.textContent]),
    comparison.candidates.map(candidate => [candidate.model, candidate.name]), 'receipt order never relabels B as A');
  for (const candidate of comparison.candidates) {
    const lane = document.querySelector(`[data-comparison-candidate="${candidate.model}"]`)!;
    const answer = document.querySelector(`[data-comparison-answer="${candidate.model}"]`)!;
    assert.equal(answer.querySelector('[data-comparison-outcome]')!.getAttribute('data-comparison-outcome'), candidate.outcome);
    assert.equal(answer.querySelector('[data-comparison-summary] [data-comparison-content]')!.textContent, candidate.summary);
    assert(answer.compareDocumentPosition(lane) & 4, 'answers precede the separate usefulness slice');
    assert.equal(lane.querySelector('[data-comparison-usefulness]')!.textContent, candidate.name, 'usefulness retains its owner when slices stack on mobile');
    assert.deepEqual([...document.querySelectorAll(`[data-comparison-arrow="${candidate.model}"]`)].map(node => [node.getAttribute('data-comparison-source'), node.getAttribute('data-comparison-target')]),
      [[`${candidate.model}:answer`, `${candidate.model}:usefulness`]], 'each candidate has one short arrow from its answer to user usefulness');
    const paths = [...lane.querySelectorAll('[data-comparison-path]')];
    assert.equal(paths.length, candidate.paths.length);
    for (const [index, path] of candidate.paths.entries()) {
      assert.equal(paths[index]!.querySelector('[data-comparison-path-title]')!.textContent, path.title);
      assert.equal(paths[index]!.querySelector('[data-comparison-assessment]')!.getAttribute('data-comparison-assessment'), path.assessment);
      assert.deepEqual([...paths[index]!.querySelectorAll('[data-comparison-stage]')].map(node => [node.getAttribute('data-comparison-stage'), node.querySelector('[data-comparison-content]')!.textContent]),
        [['evidence', path.evidence], ['impact', path.impact]]);
      assert.equal(paths[index]!.querySelector('[data-comparison-support]')!.textContent, path.evidence, 'one supplied evidence sentence leads to one impact');
      assert.equal(paths[index]!.querySelectorAll('.eris-comparison-impact').length, 1, 'the user impact is a separate conclusion line');
      assert.equal(paths[index]!.querySelectorAll('svg').length, 0, 'usefulness cards contain prose rather than internal arrow chains');
    }
  }
  assert.equal(document.querySelector('[data-comparison-verdict]')!.textContent, comparison.verdict);
  assert.equal(document.querySelector('[data-comparison-reason]')!.textContent, comparison.reason);
  const caveat = document.querySelector('[data-comparison-caveat]')!;
  assert.equal(caveat.textContent, comparison.caveat);
  assert.equal(caveat.closest('[data-analysis-comparison]'), null, 'a limitation does not become an incoming reason for the verdict');
  assert.equal(caveat.querySelectorAll('svg,path').length, 0);
  assert.equal(document.querySelectorAll('[data-comparison-conclusion]').length, 1, 'both candidates share one conclusion');
  assert(document.querySelector('[data-comparison-conclusion]')!.compareDocumentPosition(document.querySelector('[data-comparison-grid]')!) & 4, 'the shared formal conclusion appears first');
  assert.equal(document.querySelectorAll('svg').length, 2, 'the fixed template contains exactly one arrow per candidate');
  assert([...document.querySelectorAll('svg')].every(node => node.closest('.eris-comparison-transitions') && !node.closest('[data-comparison-path]')), 'desktop transitions occupy their own short row rather than routing through prose');
});

test('comparison parsing hides failures and malformed receipts while supplied markup remains literal text', () => {
  for (const state of ['error', 'pending', 'running']) assert.equal(comparisonFromToolOutput(comparisonReceipt(comparison), state), null);
  for (const output of ['', 'not JSON', JSON.stringify({ diagram: comparison }), receipt(comparison)]) assert.equal(comparisonFromToolOutput(output, 'ok'), null);
  const invalid = [
    { ...comparison, candidates: comparison.candidates.slice(0, 1) },
    { ...comparison, candidates: [...comparison.candidates, comparison.candidates[0]] },
    { ...comparison, candidates: [comparison.candidates[0], comparison.candidates[0]] },
    { ...comparison, candidates: [{ ...comparison.candidates[0], summary: '' }, comparison.candidates[1]] },
    { ...comparison, candidates: [{ ...comparison.candidates[0], outcome: 'equal' }, comparison.candidates[1]] },
    { ...comparison, candidates: [{ ...comparison.candidates[0], outcome: ['win'] }, comparison.candidates[1]] },
    ...[[], Array(4).fill(comparison.candidates[0]!.paths[0]), [null], [{ ...comparison.candidates[0]!.paths[0], evidence: null }],
      [{ ...comparison.candidates[0]!.paths[0], extra: true }],
      [{ ...comparison.candidates[0]!.paths[0], assessment: 'win' }], [{ ...comparison.candidates[0]!.paths[0], assessment: ['strength'] }],
      [{ ...comparison.candidates[0]!.paths[0], title: '超'.repeat(17) }], [{ ...comparison.candidates[0]!.paths[0], evidence: '超'.repeat(142) }],
      [{ ...comparison.candidates[0]!.paths[0], impact: '超'.repeat(37) }]]
      .map(paths => ({ ...comparison, candidates: [{ ...comparison.candidates[0], paths }, comparison.candidates[1]] })),
    { ...comparison, title: '' }, { ...comparison, verdict: 1 }, { ...comparison, reason: [] }, { ...comparison, caveat: {} },
    { ...comparison, candidates: [{ ...comparison.candidates[0], summary: '超'.repeat(81) }, comparison.candidates[1]] },
    { ...comparison, title: '超'.repeat(41) }, { ...comparison, reason: '超'.repeat(161) }, { ...comparison, caveat: '超'.repeat(101) },
  ];
  for (const diagram of invalid) assert.equal(comparisonFromToolOutput(comparisonReceipt(diagram), 'ok'), null);
  const attack = '<img src=x>';
  const diagram = { ...comparison, title: attack, candidates: comparison.candidates.map(candidate => ({ ...candidate, name: attack, summary: attack,
    paths: candidate.paths.map(path => ({ ...path, title: attack, evidence: attack, impact: attack })) })),
    verdict: attack, reason: attack, caveat: attack, html: '<script>alert(1)</script>', edges: ['b_expert -> verdict'], style: { display: 'none' } };
  const parsed = comparisonFromToolOutput(comparisonReceipt(diagram), 'ok');
  assert(parsed);
  const document = new JSDOM(renderToStaticMarkup(createElement(ComparisonDiagram, { diagram: parsed }))).window.document;
  assert.equal(document.querySelectorAll('script,img,a,iframe,foreignObject,[onerror],[onclick]').length, 0);
  assert.equal(document.querySelector('[data-comparison-stage] [data-comparison-content]')!.textContent, attack);
  assert.equal(document.querySelector('[data-comparison-caveat]')!.textContent, attack);
  assert.equal(document.querySelectorAll('[data-comparison-path]').length, 3, 'arbitrary fields cannot supply connections or branches');
  assert.equal(document.querySelector<HTMLElement>('[data-analysis-comparison]')!.style.display, '', 'arbitrary fields cannot supply styles');
});

test('comparison prose preserves complete time phrases without changing their text', () => {
  const diagram = { ...comparison, reason: '1–3周的预测不能直接等同于10月中下旬企稳' };
  const document = new JSDOM(renderToStaticMarkup(createElement(ComparisonDiagram, { diagram }))).window.document;
  const reason = document.querySelector('[data-comparison-reason]')!;
  assert.equal(reason.textContent, diagram.reason);
  assert.deepEqual([...reason.querySelectorAll('.eris-comparison-value')].map(node => node.textContent), ['1–3周', '10月中下旬']);
});

test('comparison emphasis preserves original phrases and renders supplied markup as text', () => {
  const attack = '<img src=x>';
  const first = comparison.candidates[0];
  const path = { ...first.paths[0], evidence: `原文含${attack}，数值为38.192元`, highlights: { evidence: attack } };
  const diagram = { ...comparison, reasonHighlight: '数据日期', candidates: [{ ...first, paths: [path] }, comparison.candidates[1]] };
  const parsed = comparisonFromToolOutput(comparisonReceipt(diagram), 'ok');
  assert(parsed);
  const document = new JSDOM(renderToStaticMarkup(createElement(ComparisonDiagram, { diagram: parsed }))).window.document;
  assert.equal(document.querySelector('[data-comparison-stage="evidence"] [data-comparison-content]')!.textContent, path.evidence);
  assert.equal(document.querySelector('[data-comparison-reason]')!.textContent, diagram.reason);
  assert.deepEqual([...document.querySelectorAll('[data-comparison-highlight]')].map(node => [node.tagName, node.textContent]),
    [['STRONG', '数据日期'], ['STRONG', attack]]);
  assert.equal(document.querySelectorAll('script,img,a,iframe,foreignObject,[onerror],[onclick]').length, 0);
  assert.equal(document.querySelectorAll('.eris-comparison-stage-label').length, 0, 'natural sentences require no abstract stage labels');
});

test('comparison receipts reject absent, ambiguous, oversized or unrelated highlight phrases', () => {
  const first = comparison.candidates[0];
  const withHighlights = (highlights: unknown, fields: Record<string, string> = {}) => ({ ...comparison,
    candidates: [{ ...first, paths: [{ ...first.paths[0], ...fields, highlights }] }, comparison.candidates[1]] });
  const invalid = [
    ...[null, [], {}, '38.192元', { evidence: '' }, { evidence: ['38.192元'] }, { evidence: '未出现的文本' }, { summary: '数值可直接使用' },
      { evidence: '38.192元', impact: '直接使用' }].map(highlights => withHighlights(highlights)),
    withHighlights({ evidence: '38.192元' }, { evidence: '38.192元与38.192元' }),
    withHighlights({ evidence: '超'.repeat(17) }, { evidence: '超'.repeat(17) }),
    ...['', null, [], '未出现的文本'].map(reasonHighlight => ({ ...comparison, reasonHighlight })),
    { ...comparison, reason: '相同相同', reasonHighlight: '相同' },
    { ...comparison, reason: '长'.repeat(17), reasonHighlight: '长'.repeat(17) },
  ];
  for (const diagram of invalid) assert.equal(comparisonFromToolOutput(comparisonReceipt(diagram), 'ok'), null);
});

test('comparison emphasis allows two phrases across the entire diagram and rejects any third', () => {
  const candidates = comparison.candidates.map(candidate => ({ ...candidate,
    paths: candidate.paths.map(path => ({ ...path, highlights: { evidence: path.evidence.slice(0, 2) } })) }));
  const two = { ...comparison, candidates: candidates.map(candidate => ({ ...candidate, paths: candidate.paths.slice(0, 1) })) };
  assert.deepEqual(comparisonFromToolOutput(comparisonReceipt(two), 'ok'), two);
  assert.equal(comparisonFromToolOutput(comparisonReceipt({ ...two, reasonHighlight: '数据日期' }), 'ok'), null, 'the shared reason consumes the same budget');
  assert.equal(comparisonFromToolOutput(comparisonReceipt({ ...comparison, candidates }), 'ok'), null, 'the budget spans both candidates and all their paths');
});

test('comparison visuals select only successful show_comparison receipts and deduplicate recorded calls', () => {
  const accepted = { kind: 'tool-result', callId: 'comparison-one', call: { name: 'show_comparison', argsRaw: comparisonReceipt({ ...comparison, verdict: '伪造胜者' }) },
    content: [{ type: 'text', text: comparisonReceipt(comparison) }], isError: false, subCalls: [] };
  const data = [
    { root: accepted }, { root: accepted },
    { root: { ...accepted, callId: 'failed', isError: true } },
    { root: { ...accepted, callId: 'unrelated', call: { name: 'read_data' } } },
    { root: { ...accepted, callId: 'wrong-receipt', content: [{ type: 'text', text: receipt({ ...base, type: 'heatmap' }) }] } },
    { root: { phase: 'start', name: 'show_comparison', callId: 'pending', argsRaw: comparisonReceipt(comparison), subCalls: [] } },
    { root: { kind: 'tool-result', callId: 'parent', call: { name: 'call_specialist' }, content: [], isError: false,
      subCalls: [{ ...accepted, callId: 'comparison-two' }] } },
  ];
  const selected = chartsFromToolData(data);
  assert.deepEqual(selected.map((entry: { callId: string }) => entry.callId), ['comparison-one', 'wrong-receipt', 'comparison-two']);
  assert.equal(selected[1].error, '图表数据无效，无法显示');
  assert.deepEqual(selected[0].diagram, comparison, 'recorded short labels and formal verdict cannot be replaced by tool arguments');
  const nodes = { turnDataSource: (turn: number) => ({ getSnapshot: () => turn === 7 ? data : [], subscribe: () => () => {} }) };
  const useChat = (select: (snapshot: unknown) => unknown) => select({ nodes });
  const document = new JSDOM(renderToStaticMarkup(createElement(TurnCharts, { turn: 7, useChat }))).window.document;
  assert.equal(document.querySelectorAll('[data-analysis-comparison]').length, 2);
  assert.equal(document.querySelectorAll('[data-chart-error]').length, 1);
  assert.equal(document.querySelectorAll('[data-step-process], [data-tool]').length, 0, 'a collapsed process does not own comparison visuals');
  assert.equal(renderToStaticMarkup(createElement(TurnCharts, { turn: 8, useChat })), '');
});
