import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { ROOT } from "../../tests/fixtures/services.js";

const { AnalysisChart, chartFromToolOutput, chartsFromToolData, TurnCharts } = await import(pathToFileURL(path.join(ROOT, "agent/src/client/charts.js")).href);
const receipt = (chart: Record<string, unknown>) => JSON.stringify({ kind: "chart", chart });
const base = { title: "FAST 同档对战", scope: "已完成的 2 场 FAST 对战", unit: "场", source: "本次正式对比结果",
  categories: ["A 组胜", "B 组胜"], series: [{ name: "FAST", values: [1, 1] }] };
function render(chart: Record<string, unknown>) {
  const parsed = chartFromToolOutput(receipt(chart), "ok");
  assert(parsed, "fixture should satisfy the structured chart contract");
  return new JSDOM(renderToStaticMarkup(createElement(AnalysisChart, { chart: parsed }))).window.document;
}

test('a chart stands alone and its notes add only the supplied explanation', () => {
  const note = '缺少回款明细，尚不能解释差异';
  const document = render({ ...base, type: 'dumbbell', categories: ['营收', '现金流'],
    series: [{ name: 'A组', values: [4, 1] }, { name: 'B组', values: [3, 7] }],
    annotations: [{ categoryIndex: 1, seriesIndex: 1, note }] });
  assert.equal(document.querySelectorAll('[data-chart-actions], table, [data-chart-summary]').length, 0,
    'the figure has no table view, switch or automatic repetition of the largest difference');
  assert.equal(document.querySelector('[data-chart-annotations] li')!.textContent, note,
    'the numbered note does not repeat the category, series, value or unit');
});

test("dot plot places zero, positive and negative observations on their true coordinates", () => {
  const document = render({ ...base, type: "dot", categories: ["利润变化", "现金流变化", "缺失"],
    series: [{ name: "A 组", values: [10, -4, null] }, { name: "B 组", values: [5, -2, 0] }] });
  const baseline = Number(document.querySelector("[data-zero-baseline]")!.getAttribute("x1"));
  const dots = [...document.querySelectorAll("[data-chart-mark=dot]")];
  assert.equal(dots.length, 5, 'missing observations do not become zero points');
  for (const dot of dots) {
    const value = Number(dot.getAttribute('data-value')), x = Number(dot.getAttribute('cx'));
    if (value < 0) assert(x < baseline);
    else if (value > 0) assert(x > baseline);
    else assert.equal(x, baseline);
  }
  assert.equal(document.querySelector("[data-chart-type=dot]")!.getAttribute("role"), "img");
  assert.match(document.querySelector("[data-chart-accessible-data]")!.textContent!, /未知/);
  assert.deepEqual([...document.querySelectorAll("[data-chart-accessible-data] dt")].map(node => node.textContent), ["利润变化", "现金流变化", "缺失"]);
  assert.deepEqual(new Set(dots.filter(dot => dot.getAttribute("data-series") === "A 组").map(dot => dot.getAttribute("fill"))).size, 1);
  assert.deepEqual([...document.querySelectorAll("[data-chart-value]")].map(node => node.textContent), ["10", "5", "-4", "-2", "0"]);
  assert([...document.querySelectorAll('[data-axis-tick]')].every(node => Number.isInteger(Number(node.textContent))));
  assert(dots.every(dot => dot.getAttribute('r') === '4'), 'point size does not encode or distort value');
  assert.equal(document.querySelectorAll('rect').length, 0, 'quantities are represented by position, without columns');
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
  const document = render({ ...base, type: "dot", title: attack, scope: attack, source: attack,
    categories: [attack, "B 组"], series: [{ name: attack, values: [2, 1] }] });
  assert.equal(document.querySelectorAll("script,img,a,iframe").length, 0);
  assert.equal(document.querySelector("h3")!.textContent, attack);
  assert(document.querySelector("figcaption")!.textContent!.includes(attack));
  assert.match(document.querySelector("figcaption")!.textContent!, / · 场/);
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
  const svg = document.querySelector("svg")!;
  assert.equal(svg.getAttribute("width"), "514", "the bounded chart retains a pixel coordinate system instead of shrinking its text");
  assert.equal(svg.getAttribute("viewBox")!.split(' ')[2], "514");
  assert.equal(document.querySelector('[data-chart-legend]'), null, 'a single series does not repeat a redundant legend');
  assert.equal(document.querySelector('footer')!.textContent, `来源：${attack}`);
  assert.equal(document.querySelector<HTMLElement>('footer')!.style.borderTop, '', 'the source has no extra footer divider');
  assert.equal(document.querySelectorAll('svg title').length, 0, 'charts expose accessible names without browser hover text');
});

test('short chart summaries stay compact without losing actual values, scope or source', () => {
  const composition = render({ ...base, type: 'pie', title: '17 次运行中 6 次完成', scope: '17 次运行的当前状态',
    categories: ['已完成', '中断'], series: [{ name: '运行', values: [6, 11] }] });
  const ring = composition.querySelector('svg')!;
  assert(Number(ring.getAttribute('width')) <= 144 && Number(ring.getAttribute('height')) <= 144, 'a two-category summary does not occupy a large plot');
  assert.equal(composition.querySelector('[data-chart-total]')!.textContent, '17');
  assert.deepEqual([...composition.querySelectorAll('[data-chart-composition-value]')].map(node => node.textContent), ['6', '11']);
  assert.deepEqual([...composition.querySelectorAll('[data-chart-share]')].map(node => node.textContent), ['35.29%', '64.71%']);
  assert(composition.querySelector('figcaption')!.textContent!.includes('17 次运行的当前状态'));
  assert.equal(composition.querySelector('footer')!.textContent, `来源：${base.source}`);
  const dots = render({ ...base, type: 'dot', categories: ['覆盖', '已完成', '中断', '未知'],
    series: [{ name: '数量', values: [17, 6, 11, null] }] });
  assert(Number(dots.querySelector('svg')!.getAttribute('height')) <= 200, 'four short rows fit a compact reading area');
  assert.deepEqual([...dots.querySelectorAll('[data-chart-value]')].map(node => node.textContent), ['17', '6', '11']);
  assert.equal(dots.querySelector('[data-chart-unknown]')!.textContent, '未知');
  const wideTotal = render({ ...base, type: 'pie', series: [{ name: '数量', values: [60000, 60000] }] });
  const total = wideTotal.querySelector('[data-chart-total]')!;
  assert.equal(total.textContent, '120,000');
  assert.equal(total.closest('[data-chart-denominator]'), null, 'even a six-digit total moves below the smaller ring when it would collide with its centre');
  assert.match(wideTotal.querySelector('[data-chart-accessible-data]')!.textContent!, /50% \(60,000\/120,000\)/);
});

test('comparison labels wrap without dropping text and identity colours do not track the winner or input order', () => {
  const longName = '财务研究中的经营现金流与利润口径差异'.repeat(5);
  const document = render({ ...base, type: 'dot', categories: [longName, 'A组Fast', 'B 组Fast'], series: [{ name: '胜场', values: [1, 6, 5] }] });
  const labels = [...document.querySelectorAll('[data-chart-label=category]')];
  assert.equal(labels[0].textContent, longName);
  assert(labels[0].querySelectorAll('tspan').length > 1);
  const dots = [...document.querySelectorAll('[data-chart-mark=dot]')];
  assert(Number(dots[1].getAttribute('cy')) > Number(dots[0].getAttribute('cy')) + 20, 'long labels receive row height instead of overlapping the next category');
  const swapped = render({ ...base, type: 'dot', categories: ['B: Fast', 'A 组Fast'], series: [{ name: '胜场', values: [9, 2] }] });
  assert.equal(dots[1].getAttribute('fill'), swapped.querySelector('[data-category="A 组Fast"]')!.getAttribute('fill'));
  assert.equal(dots[2].getAttribute('fill'), swapped.querySelector('[data-category="B: Fast"]')!.getAttribute('fill'));
  assert.notEqual(dots[1].getAttribute('fill'), dots[2].getAttribute('fill'));
  assert.equal(dots[1].getAttribute('fill'), '#556c8d');
  assert.equal(dots[2].getAttribute('fill'), '#e5c5c1');
  const generic = render({ ...base, type: 'dot', categories: ['Apple', 'ABC', 'BA'], series: [{ name: '指标', values: [1, 2, 3] }] });
  assert.equal(new Set([...generic.querySelectorAll('[data-chart-mark=dot]')].map(node => node.getAttribute('fill'))).size, 1, 'ordinary names are not guessed to be A/B/C identities');
  const ranking = render({ ...base, type: 'dot', categories: ['证据缺失', '口径混用'], series: [{ name: 'B组Fast', values: [2, 1] }] });
  assert([...ranking.querySelectorAll('[data-chart-mark=dot]')].every(node => node.getAttribute('fill') === dots[1].getAttribute('fill')), 'a single-model issue ranking remains neutral grey even for a B-labelled model');
  const binary = render({ ...base, type: 'dot' });
  assert.deepEqual([...binary.querySelectorAll('[data-axis-tick]')].map(node => node.textContent), ['0', '1'], 'one observed count never produces fractional-count ticks');
  for (const maximum of [5, 7]) {
    const counts = render({ ...base, type: 'dot', series: [{ name: '胜场', values: [maximum, maximum - 1] }] });
    const ticks = [...counts.querySelectorAll('[data-axis-tick]')].map(node => Number(node.textContent));
    assert(ticks.every(Number.isInteger), `maximum ${maximum} still uses whole-count ticks`);
    assert(ticks.at(-1)! >= maximum, 'integer rounding retains the full observed range');
  }
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

test('a narrow trend reserves exact scientific labels and exposes keyboard and pointer readouts', async () => {
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
    assert.equal(readout.style.visibility, 'hidden');
    assert.equal(readout.style.position, 'absolute', 'inactive point readings reserve no empty row under the plot');
    await act(async () => { targets[1].focus(); });
    assert.equal(readout.style.visibility, 'visible');
    assert.equal(readout.textContent, `2026-01-21 · A组Fast · ${label.textContent} 示例值`);
    await act(async () => { targets[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(readout.style.visibility, 'hidden');
    await act(async () => { targets[0].dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true,
      clientX: Number(targets[0].getAttribute('cx')), clientY: Number(targets[0].getAttribute('cy')) })); });
    assert.equal(readout.textContent, '2026-01-01 · A组Fast · 1E-9 示例值');
    for (const pointerType of ['touch', 'mouse']) {
      const leave = new dom.window.MouseEvent('pointerout', { bubbles: true });
      Object.defineProperty(leave, 'pointerType', { value: pointerType });
      await act(async () => { targets[0].dispatchEvent(leave); });
      assert.equal(readout.style.visibility, pointerType === 'touch' ? 'visible' : 'hidden', 'touch release preserves the exact reading while mouse leave clears it');
    }
    const collision = { ...base, type: 'line', categories: ['2026-01-01', '2026-01-02', '2026-01-21'],
      series: [{ name: 'A组', values: [1.05, 1.05, 2] }, { name: 'B组', values: [1, 1, 2] }] };
    await act(async () => { root.render(createElement(AnalysisChart, { chart: collision })); });
    const first = dom.window.document.querySelector<SVGElement>('[data-chart-hit][data-series="A组"][data-date="2026-01-01"]')!;
    const coveringTarget = dom.window.document.querySelector<SVGElement>('[data-chart-hit][data-series="B组"][data-date="2026-01-02"]')!;
    assert(Math.abs(Number(first.getAttribute('cx')) - Number(coveringTarget.getAttribute('cx'))) < 22, 'the fixture has genuinely overlapping neighbouring targets');
    await act(async () => { coveringTarget.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true,
      clientX: Number(first.getAttribute('cx')), clientY: Number(first.getAttribute('cy')) })); });
    assert.equal(readout.textContent, '2026-01-01 · A组 · 1.05 场', 'pointer coordinates select the real nearest point even when another hit target receives the event');
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
  for (const state of ["preparing", "running", "error", "stopped"]) assert.equal(chartFromToolOutput(receipt({ ...base, type: "dot" }), state), null);
  for (const output of ["", "not JSON", JSON.stringify({ chart: { ...base, type: "dot" } }), JSON.stringify({ kind: "chart", html: "<script/>" })])
    assert.equal(chartFromToolOutput(output, "ok"), null);
  const invalid = [
    { ...base, type: "html" }, { ...base, type: "dot", series: [{ name: "FAST", values: [1] }] },
    { ...base, type: "dot", series: [{ name: "FAST", values: [1, "2"] }] },
    { ...base, type: "pie", series: [{ name: "FAST", values: [0, 0] }] },
    { ...base, type: "pie", series: [{ name: "FAST", values: [1, -1] }] },
    { ...base, type: "pie", categories: Array.from({ length: 7 }, (_, index) => String(index)), series: [{ name: "FAST", values: Array(7).fill(1) }] },
    { ...base, type: "line", categories: ["2026-01-02", "2026-01-01"] },
    { ...base, type: "line", categories: ["2026-01-01", "2026-01-01"] },
    { ...base, type: "line", categories: ["FAST", "Expert"] },
    { ...base, type: "line", categories: ["2026-02-30", "2026-03-04"] },
    { ...base, type: "dot", series: [{ name: "FAST", values: [null, null] }] },
    { ...base, type: "dot", series: [{ name: "FAST", values: [1, 2] }, { name: "FAST", values: [3, 4] }] },
    { ...base, type: "dot", series: [{ name: "FAST", values: [1e16, 2] }] },
  ];
  for (const chart of invalid) assert.equal(chartFromToolOutput(receipt(chart), "ok"), null);
  assert.equal(chartFromToolOutput('{"kind":"chart","chart":{"type":"dot","title":"x","scope":"x","unit":"x","source":"x","categories":["x"],"series":[{"name":"x","values":[1e400]}]}}', "ok"), null);
});

test("small nonzero chart values retain their magnitude instead of rounding to zero", () => {
  const document = render({ ...base, type: "dot", series: [{ name: "变化", values: [1e-9, -1e-9] }] });
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
  const chart = { ...base, type: "dot" };
  const accepted = { kind: "tool-result", callId: "chart-one", call: { name: "show_chart", argsRaw: JSON.stringify({ ...chart, series: [{ name: "FAST", values: [100, 0] }] }) },
    content: [{ type: "text", text: receipt(chart) }], isError: false, subCalls: [] };
  const data = [
    { root: accepted }, { root: accepted },
    { root: { ...accepted, callId: "failed-chart", isError: true } },
    { root: { ...accepted, callId: "different-tool", call: { name: "read_data" } } },
    { root: { phase: "start", name: "show_chart", callId: "preparing-chart", argsRaw: receipt(chart), subCalls: [] } },
    { root: { kind: "tool-result", callId: "parent", call: { name: "call_specialist" }, content: [], isError: false,
      subCalls: [{ ...accepted, callId: "chart-two" }] } },
  ];
  const results = chartsFromToolData(data);
  assert.deepEqual(results.map((entry: { callId: string }) => entry.callId), ["chart-one", "chart-two"]);
  assert.deepEqual(results[0].chart.series[0].values, [1, 1], "arguments cannot replace the recorded receipt values");
  assert.equal(chartsFromToolData([{ root: { ...accepted, content: [{ type: "text", text: "invalid receipt" }] } }]).length, 0);
});

test("the public Turn-tail renderer reads only its Turn's tool source and renders outside work-step disclosures", () => {
  const data = [{ root: { kind: "tool-result", callId: "chart-one", call: { name: "show_chart" }, isError: false,
    content: [{ type: "text", text: receipt({ ...base, type: "dot" }) }], subCalls: [] } }];
  const requests: unknown[] = [];
  const nodes = { turnDataSource(turn: number, kind: string) {
    requests.push([turn, kind]);
    return { getSnapshot: () => data, subscribe: () => () => {} };
  } };
  const useChat = (select: (snapshot: unknown) => unknown) => select({ nodes });
  const document = new JSDOM(renderToStaticMarkup(createElement(TurnCharts, { turn: { turn: 7 }, useChat }))).window.document;
  assert.deepEqual(requests, [[7, "tool-call"]]);
  assert.equal(document.querySelectorAll('[data-turn-charts="7"] figure').length, 1);
  assert.equal(document.querySelectorAll('[data-step-process], [data-tool]').length, 0);
});
