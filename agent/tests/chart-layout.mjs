import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { chartTemplates } from '../src/client/chart-templates.js';
import { serveAssistant } from '@eval/runtime/assistant';

const output = process.cwd() + '/.artifacts/chart-layout';
await mkdir(output, { recursive: true });
const server = await serveAssistant({ port: 0, userId: 'layout', webDirectory: process.cwd() + '/dist/agent/web',
  endpoints: () => ({ async call() { throw new Error('Unexpected RPC'); }, async stream() { throw new Error('Unexpected stream'); }, async dispose() {} }) });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(server.url + '/u/layout/chart-gallery.html');
  await page.locator('[data-template]').last().locator('svg').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const failures = [];
  const expectedLabels = Object.fromEntries(chartTemplates.map(({id, chart}) => [id, ['bar','heatmap','bubble_matrix','slope','waterfall','interval','radial_heatmap'].includes(chart.type) ? chart.categories : ['boxplot','violin','ridgeline'].includes(chart.type) ? chart.series.map(s => s.name) : []]));
  for (const width of [1440, 1024, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const collisions = await page.locator('[data-template]').evaluateAll((cards, expectedLabels) => cards.flatMap(card => {
      const labels = [...card.querySelectorAll('[data-chart-plot] svg text')].filter(node => {
        const style = getComputedStyle(node);
        return node.textContent.trim() && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      }).map(node => ({ text: node.textContent, box: node.getBoundingClientRect() })).filter(({box}) => box.width > 0 && box.height > 0);
      const overlaps = [];
      for (const expected of expectedLabels[card.dataset.template] ?? []) if (!labels.some(label => label.text === expected)) overlaps.push({ splitOrMissingLabel: expected });
      for (const text of card.querySelectorAll('[data-chart-plot] svg text')) if ([...text.querySelectorAll('tspan')].some(span => Number(span.getAttribute('dy')) > 0)) overlaps.push({ multilineLabel: text.textContent });
      for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        if (x > 1 && y > 1) overlaps.push({ first: a.text, second: b.text, overlap: [Math.round(x * 10) / 10, Math.round(y * 10) / 10] });
      }
      return overlaps.length ? [{ template: card.dataset.template, overlaps }] : [];
    }), expectedLabels);
    for (const item of collisions) {
      failures.push({ width, ...item });
      await page.locator(`[data-template="${item.template}"]`).screenshot({ path: `${output}/${width}-${item.template}.png` });
    }
  }
  await writeFile(output + '/collisions.json', JSON.stringify({ failures, errors }, null, 2));
  console.log(JSON.stringify(failures, null, 2));
  assert.deepEqual(errors, []);
  assert.equal(failures.length, 0, 'chart text must stay on one line without overlap at desktop, split-pane or phone widths');
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.getByRole('button', { name: '环形', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: output + '/after.png' });
  console.log('All chart templates have single-line, non-overlapping labels at five viewport widths.');
} finally { await browser.close(); await server.close(); }
