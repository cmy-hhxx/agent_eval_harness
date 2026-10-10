import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { serveAssistant } from '@eval/runtime/assistant';
import { chartTemplates } from '../src/client/chart-templates.js';

const failedChart = { type: 'heatmap', title: 'B组在各档的正式对战结果', scope: '加载回归：Fast 166场、Expert 130场',
  unit: '场', source: '失败截图的固定回归数据', categories: ['Fast', 'Expert'], series: [
    { name: 'A组胜', values: [35, 60] }, { name: 'B组胜', values: [64, 30] },
    { name: '双方都好', values: [62, 37] }, { name: '双方都差', values: [5, 3] },
  ] };
const charts = [failedChart, ...chartTemplates.map(({ chart }) => chart)];
const directory = await mkdtemp(tmpdir() + '/eris-chart-loading-');
let server, browser;
try {
  // Delay the first chart until the page's initial module graph has loaded.
  await build({ stdin: { contents: `
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AnalysisChart } from './agent/src/client/charts.js';
    const charts = ${JSON.stringify(charts)};
    const root = createRoot(document.getElementById('root'));
    let index = 0;
    document.getElementById('show').onclick = () => root.render(
      h(AnalysisChart, { chart: charts[index++ % charts.length] }));
    document.getElementById('clear').onclick = () => root.render(null);
    document.getElementById('show').disabled = false;
  `, resolveDir: process.cwd() }, entryNames: 'chart-test', outdir: directory,
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2023',
    define: { 'process.env.NODE_ENV': '"production"' } });
  await writeFile(directory + '/index.html', '<!doctype html><html><body><button id="show" disabled>显示图表</button><button id="clear">清空</button><div id="root"></div><script type="module" src="./chart-test.js"></script></body></html>');
  server = await serveAssistant({ port: 0, userId: 'loading', webDirectory: directory,
    endpoints: () => ({ async call() { throw new Error('Unexpected RPC'); }, async stream() { throw new Error('Unexpected stream'); }, async dispose() {} }) });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  const errors = [], lateScripts = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(server.url + '/u/loading/');
  await page.waitForFunction(() => !document.getElementById('show').disabled);
  // A rebuild removes old chunks; an already-open conversation must still draw new receipts.
  await page.route('**/*.js', route => {
    lateScripts.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Asset removed after rebuild' });
  });
  for (let mount = 0; mount < charts.length * 2; mount++) {
    await page.locator('#show').click();
    await page.waitForFunction(() => document.querySelector('[data-chart-plot] svg')
      || document.querySelector('[data-chart-plot] [role=alert]'));
    const missing = await page.locator('[data-analysis-chart]').evaluateAll(figures => figures
      .filter(figure => !figure.querySelector('[data-chart-plot] svg'))
      .map(figure => ({ type: figure.dataset.analysisChart, message: figure.querySelector('[data-chart-plot]').textContent })));
    assert.deepEqual(missing, [], 'accepted charts must render without a reload button when old asset URLs become unavailable');
    assert.equal(await page.locator('[data-analysis-chart]').count(), 1);
    if (mount % charts.length === 0) {
      assert.equal(await page.locator('[data-chart-unit]').textContent(), '合计 296 场');
      const labels = await page.locator('[data-chart-plot] svg text').allTextContents();
      for (const label of ['Fast', 'Expert', '166 场', '130 场', ...failedChart.series.flatMap(s => [s.name, ...s.values.map(String)])])
        assert(labels.includes(label), `recovered chart must display ${label}`);
      if (mount === 0) {
        await mkdir('.artifacts/chart-loading', { recursive: true });
        await page.locator('[data-analysis-chart]').screenshot({ path: '.artifacts/chart-loading/recovered.png' });
      }
    }
    await page.locator('#clear').click();
    await page.locator('[data-analysis-chart]').waitFor({ state: 'detached' });
  }
  assert.deepEqual(lateScripts, [], 'drawing a chart after startup must not require another script request');
  assert.deepEqual(errors, []);
  console.log(`The reported 296-battle chart and ${chartTemplates.length} templates render and remount without fetching scripts after startup.`);
} finally {
  await browser?.close(); await server?.close();
  await rm(directory, { recursive: true, force: true });
}
