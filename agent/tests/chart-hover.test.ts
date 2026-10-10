import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { init } from 'echarts/core';
import { ROOT } from '../../tests/fixtures/services.js';

const client = (file: string) => import(pathToFileURL(path.join(ROOT, 'agent/src/client', file)).href);
const { installChartHover } = await client('chart-hover.js');
const { AnalysisChart } = await client('charts.js');
const { researchOption } = await client('chart-research.js');
const { chartTemplates } = await client('chart-templates.js');
const { researchTypes } = await client('chart-data.js');
const { chartTheme } = await client('chart-theme.js');

class Matrix {
  constructor(public a = 1, public b = 0, public c = 0, public d = 1, public e = 0, public f = 0) {}
  inverse() {
    const det = this.a * this.d - this.b * this.c;
    return new Matrix(this.d / det, -this.b / det, -this.c / det, this.a / det,
      (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det);
  }
  multiply(m: Matrix) {
    return new Matrix(this.a * m.a + this.c * m.b, this.b * m.a + this.d * m.b,
      this.a * m.c + this.c * m.d, this.b * m.c + this.d * m.d,
      this.a * m.e + this.c * m.f + this.e, this.b * m.e + this.d * m.f + this.f);
  }
}

function fixture(markup: string) {
  const dom = new JSDOM(markup), { document, SVGElement, DOMRect } = dom.window;
  // JSDOM has no layout; supply explicit screen geometry to exercise SVG coordinate conversion.
  Object.defineProperty(SVGElement.prototype, 'getScreenCTM', { value: () => new Matrix() });
  SVGElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 100, 40);
  const root = document.querySelector('figure')!;
  const cleanup = installChartHover(root);
  const hover = (mark: Element) => mark.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
  const leave = (mark: Element) => mark.dispatchEvent(new dom.window.MouseEvent('pointerout', { bubbles: true }));
  return { dom, document, root, cleanup, hover, leave };
}

test('zoom and shadow exclude every label with 3px screen clearance without moving original marks', () => {
  const f = fixture('<figure><svg><text>相邻标签</text><g transform="translate(20 10)"><path id="data" data-radial-cell tabindex="0" role="img" aria-label="35 场" fill="#123" d="M0 0h60v40H0z"/></g><text>35</text></svg></figure>');
  const svg = f.root.querySelector('svg')!, mark = f.document.getElementById('data')!;
  Object.defineProperty(svg, 'getScreenCTM', { value: () => new Matrix(2, 0, 0, 2, 100, 200) });
  Object.defineProperty(mark, 'getScreenCTM', { value: () => new Matrix(2, 0, 0, 2, 140, 220) });
  svg.getBoundingClientRect = () => new f.dom.window.DOMRect(100, 200, 1028, 600);
  mark.getBoundingClientRect = () => new f.dom.window.DOMRect(140, 220, 120, 80);
  [...f.root.querySelectorAll('text')].forEach((text, index) => {
    text.getBoundingClientRect = () => new f.dom.window.DOMRect(130 + 60 * index, 248, 40, 20);
  });
  const before = mark.outerHTML;
  try {
    f.hover(mark);
    const layer = f.root.querySelector('[data-chart-hover-layer]')!;
    const holes = [...layer.querySelectorAll('mask rect[fill="black"]')];
    assert.equal(holes.length, 2, 'protect labels before and after the mark in drawing order');
    holes.forEach((hole, index) => assert.deepEqual(['x', 'y', 'width', 'height'].map(a => Number(hole.getAttribute(a))), [13.5 + 30 * index, 22.5, 23, 13]));
    assert.equal(layer.getAttribute('pointer-events'), 'none', 'enlarged paint never changes hit testing');
    assert.equal(layer.getAttribute('aria-hidden'), 'true');
    assert.equal(layer.querySelectorAll('text, [tabindex], [aria-label], title').length, 0, 'no duplicate text, tooltip or focus target');
    assert.equal(layer.querySelector('[transform]')!.getAttribute('transform'), 'matrix(1 0 0 1 20 10)');
    assert(layer.querySelector('[mask]')!.contains(layer.querySelector('.eris-chart-hover-mark')), 'mask also encloses the shadow');
    assert.equal(mark.outerHTML, before, 'data geometry and keyboard semantics remain untouched');
  } finally { f.cleanup(); }
});

test('large marks cap expansion at 2px and re-entry reverses the same transition cleanly', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('<figure><svg><path data-chart-mark="wedge" fill="blue"/></svg></figure>');
  const mark = f.root.querySelector('path')!;
  mark.getBoundingClientRect = () => new f.dom.window.DOMRect(0, 0, 600, 240);
  try {
    f.hover(mark);
    const layer = f.root.querySelector('[data-chart-hover-layer]')!;
    const scale = Number(layer.querySelector<SVGElement>('.eris-chart-hover-mark')!.style.getPropertyValue('--eris-hover-scale'));
    assert(Math.abs((scale - 1) * 600 / 2 - 2) < 1e-8);
    f.leave(mark);
    assert(!layer.hasAttribute('data-active'));
    t.mock.timers.tick(120);
    f.hover(mark);
    assert.equal(f.root.querySelectorAll('[data-chart-hover-layer]').length, 1, 'quick re-entry reuses the fading layer');
    assert(layer.hasAttribute('data-active'));
    t.mock.timers.tick(240);
    assert(layer.isConnected);
    f.leave(mark);
    t.mock.timers.tick(240);
    assert(!layer.isConnected, 'exit removes the effect and its mask');
    f.hover(mark);
    f.cleanup();
    assert.equal(f.root.querySelectorAll('[data-chart-hover-layer]').length, 0);
    f.hover(mark);
    assert.equal(f.root.querySelectorAll('[data-chart-hover-layer]').length, 0, 'unmount removes event handlers');
  } finally { f.cleanup(); }
});

test('every gallery renderer uses the shared hover while text, guides and canvases remain still', () => {
  for (const { id, chart } of chartTemplates) {
    let markup;
    if (researchTypes.includes(chart.type)) {
      const engine = init(null, null, { renderer: 'svg', ssr: true, width: 514, height: 300 });
      try {
        const option = researchOption(chart, 514);
        assert(option.series.every((s: { emphasis: { disabled: boolean } }) => s.emphasis.disabled), `${id}: no competing renderer emphasis`);
        engine.setOption(option);
        markup = `<figure><div data-research-chart="${chart.type}">${engine.renderToSVGString()}</div></figure>`;
      } finally { engine.dispose(); }
    } else markup = renderToStaticMarkup(createElement(AnalysisChart, { chart }));
    const f = fixture(markup);
    try {
      let hovered = 0;
      const originals = [...f.root.querySelectorAll('svg path, svg rect, svg circle, svg polygon, svg polyline')];
      for (const mark of originals) {
        f.hover(mark);
        const layer = f.root.querySelector('[data-chart-hover-layer][data-active]');
        if (researchTypes.includes(chart.type) && mark.tagName === 'path' && mark.getAttribute('fill') === 'none' && mark.hasAttribute('stroke')) {
          if (mark.getAttribute('stroke')?.toLowerCase() === chartTheme.grid.toLowerCase()) assert.equal(layer, null, `${id}: grid stays still`);
          else if (mark.getAttribute('stroke') !== 'none' && mark.getAttribute('stroke-opacity') !== '0') assert(layer, `${id}: data lines also receive the effect`);
        }
        if (layer) {
          hovered++;
          assert.equal(layer.querySelector('.eris-chart-hover-mark')!.tagName, mark.tagName);
        }
      }
      assert(hovered > 0, `${id}: data marks receive the shared effect`);
      for (const background of f.root.querySelectorAll('svg, text')) {
        f.hover(background);
        assert.equal(f.root.querySelector('[data-chart-hover-layer][data-active]'), null, `${id}: labels and canvas stay still`);
      }
    } finally { f.cleanup(); f.dom.window.close(); }
  }
});
