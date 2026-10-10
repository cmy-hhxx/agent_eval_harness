import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { serveAssistant } from '@eval/runtime/assistant';
import { chartTemplates } from '../src/client/chart-templates.js';

const directory = await mkdtemp(tmpdir() + '/eris-chart-resilience-');
let browser, server;
try {
  await build({ stdin: { contents: `
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AnalysisChart, TurnCharts } from './agent/src/client/charts.js';
    const examples = ${JSON.stringify(chartTemplates.map(t => t.chart))};
    const root = createRoot(document.getElementById('root'));
    window.chartProbe = { stage: '', remaining: 0, attempts: 0, instances: [] };
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      observe(element) {
        const state = window.chartProbe;
        if (state.stage === 'observe' && element.closest('[data-research-chart]')) {
          state.attempts++;
          if (state.remaining !== 0) { if (state.remaining > 0) state.remaining--; throw new Error('Injected chart observe failure'); }
        }
        return super.observe(element);
      }
    };
    let key = 0;
    window.draw = (stage = '', remaining = 0, hidden = false) => {
      Object.assign(window.chartProbe, { stage, remaining, attempts: 0 });
      key++;
      window.redraw = () => root.render(h('div', { key },
        h('p', { id: 'answer' }, '回复正文保持可见'),
        h('div', { id: 'target', style: { display: hidden ? 'none' : 'block' } }, h(AnalysisChart, { chart: { ...examples.find(c => c.type === 'heatmap') } })),
        h('div', { id: 'sibling' }, h(AnalysisChart, { chart: examples.find(c => c.type === 'pie') }))));
      window.redraw();
    };
    window.corrupt = () => {
      const chart = examples.find(c => c.type === 'pie');
      const records = ['invalid JSON', JSON.stringify({ kind: 'chart', chart })].map((text, i) => ({ root: {
        kind: 'tool-result', callId: String(i), call: { name: 'show_chart' }, isError: false, content: [{ type: 'text', text }] } }));
      const nodes = { turnDataSource: () => ({ subscribe: () => () => {}, getSnapshot: () => records }) };
      root.render(h(TurnCharts, { key: ++key, turn: 1, useChat: select => select({ nodes }) }));
    };
    window.clear = () => root.render(null);
  `, resolveDir: process.cwd() }, outdir: directory, entryNames: 'test', bundle: true, format: 'esm', target: 'es2023',
    define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'chart-engine-faults', setup(builder) {
      builder.onResolve({ filter: /^echarts\/core$/ }, () => ({ path: 'engine', namespace: 'chart-probe' }));
      builder.onLoad({ filter: /.*/, namespace: 'chart-probe' }, () => ({ contents: `
        import { init as actualInit, use } from ${JSON.stringify(process.cwd() + '/node_modules/echarts/core.js')};
        export { use };
        function probe(stage) {
          const state = window.chartProbe;
          if (state.stage !== stage) return;
          state.attempts++;
          if (state.remaining !== 0) { if (state.remaining > 0) state.remaining--; throw new Error('Injected chart ' + stage + ' failure'); }
        }
        export function init(...args) {
          probe('init');
          const engine = actualInit(...args);
          window.chartProbe.instances.push(engine);
          for (const stage of ['setOption', 'resize']) {
            const original = engine[stage].bind(engine);
            engine[stage] = (...values) => { probe(stage); return original(...values); };
          }
          return engine;
        }
      `, resolveDir: process.cwd() }));
    } }] });
  await writeFile(directory + '/index.html', '<!doctype html><html><body><div id="root"></div><script type="module" src="./test.js"></script></body></html>');
  server = await serveAssistant({ port: 0, userId: 'charts', webDirectory: directory,
    endpoints: () => ({ async call() { throw new Error('Unexpected RPC'); }, async stream() { throw new Error('Unexpected stream'); }, async dispose() {} }) });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  const unhandled = [];
  page.on('pageerror', error => unhandled.push(String(error)));
  await page.goto(server.url + '/u/charts/');
  await page.waitForFunction(() => window.draw);
  for (const stage of ['init', 'observe', 'setOption', 'resize']) {
    await page.evaluate(stage => window.draw(stage, 1), stage);
    await page.waitForFunction(() => window.chartProbe.attempts >= 2 && document.querySelector('#target svg') && !document.querySelector('[data-chart-error]'));
    assert.equal(await page.locator('#answer').textContent(), '回复正文保持可见');
    assert.equal(await page.locator('#sibling svg').count(), 1);
    assert.equal(await page.evaluate(() => window.chartProbe.instances.filter(engine => !engine.isDisposed()).length), 1, `${stage}: failed instances are disposed before recovery`);
    await page.evaluate(() => window.clear());
    await page.waitForFunction(() => window.chartProbe.instances.every(engine => engine.isDisposed()));
  }
  await page.evaluate(() => window.draw('setOption', -1));
  await page.locator('#target [role=alert]').waitFor();
  assert.equal(await page.locator('#target [role=alert]').textContent(), chartTemplates.find(t => t.chart.type === 'heatmap').chart.title + '图表暂时无法显示重试图表');
  const attempts = await page.evaluate(() => window.chartProbe.attempts);
  assert.equal(attempts, 2, 'only one automatic remount is allowed');
  await page.evaluate(() => window.redraw());
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  assert.equal(await page.evaluate(() => window.chartProbe.attempts), attempts, 'persistent failures do not keep retrying');
  assert.equal(await page.locator('#sibling svg').count(), 1);
  await page.evaluate(() => { window.chartProbe.remaining = 0; });
  await page.getByRole('button', { name: '重试图表' }).click();
  await page.locator('#target svg').waitFor();
  await page.evaluate(() => window.draw('', 0, true));
  await page.locator('#target svg').waitFor({ state: 'attached' });
  await page.evaluate(() => { document.getElementById('target').style.display = 'block'; });
  await page.locator('#target svg').waitFor();
  for (const width of [320, 1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => { const svg = document.querySelector('#target svg'); const box = svg?.getBoundingClientRect(); return box?.width > 0 && box.height > 0 && svg.querySelector('path'); });
  }
  await page.evaluate(() => window.corrupt());
  await page.locator('[data-chart-error]').waitFor();
  assert.equal(await page.locator('[data-chart-error]').textContent(), '图表数据无效，无法显示');
  assert.equal(await page.locator('[data-analysis-chart=pie] svg').count(), 1);
  await page.evaluate(() => window.clear());
  await page.waitForFunction(() => window.chartProbe.instances.every(engine => engine.isDisposed()));
  assert.deepEqual(unhandled, [], 'chart failures must not escape into the conversation or observer callbacks');
  console.log('Chart init, observation, update and resize recovery, persistent error isolation, hidden containers, receipt errors and disposal: passed');
} finally { await browser?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); }
