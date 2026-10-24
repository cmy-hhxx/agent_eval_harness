import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AssistantSessions, serveAssistant } from '@eval/runtime/assistant';
import { assistantEndpoints } from '@eval/assistant/server';

const directory = await mkdtemp(tmpdir() + '/assistant-evidence-');
const shots = process.cwd() + '/.artifacts/agent-evidence';
await mkdir(shots, { recursive: true });
const fixtures = [
 { columns: 10, name: '华夏中证新能源汽车产业交易型开放式指数证券投资基金', code: '159637.SZ' },
 { columns: 14, name: '中证沪深港人工智能与高端制造产业主题指数增强型证券投资基金人民币份额', code: '930713.CSI' },
 { columns: 18, name: 'Global Advanced Manufacturing and Renewable Energy Investment Holdings Limited', code: 'CNBOND20261011001' },
].map((fixture, index) => {
 const headers = ['证券代码', '证券名称', '日期', '最新价', '涨跌幅', '成交额', '成交量', '换手率', '市盈率', '市净率', '总市值', '流通市值', '量比', '振幅', '开盘价', '最高价', '最低价', '收盘价'].slice(0, fixture.columns);
 const rows = Array.from({ length: 3 }, (_, row) => [row === 0 ? fixture.code : `60000${row}.SH`, `${fixture.name}（${row + 1}）`, '2026-10-09', ...Array.from({ length: fixture.columns - 3 }, (_, col) => col % 3 === 0 ? `${row + 1},23${col}.56` : col % 3 === 1 ? `+${row + 1}.${col}%` : `${row + 1}000${col}`)]);
 const markdown = [headers, headers.map(() => '---'), ...rows].map(row => '|' + row.join('|') + '|').join('\n');
 return { ...fixture, index: index + 6, headers, rows, raw: JSON.stringify([{ type: 'input_text', text: markdown }]) };
});
const reference = { collectionId: "0_wencai/0_daily_eval", runId: 'table-stress', taskId: 'pair' }, args = { reference };
const material = { kind: 'case', reference, question: '宽表与长名称的界面测试', answers: [{
 modelName: 'A组Expert', answer: { text: '表格测试材料', complete: true, reference: { collectionId: "0_wencai/0_daily_eval", runId: reference.runId, inputId: 'table-input', messageIndex: 10 } },
 trace: { messageCount: 11, toolCalls: 3, finalMessageIndex: 10, nodes: Array.from({ length: 11 }, (_, index) => ({
  messageIndex: index, type: index === 0 ? 'user_question' : index === 10 ? 'final_answer' : index >= 6 && index <= 8 ? 'tool_result' : index >= 3 && index <= 5 ? 'tool_call' : 'reasoning',
  ...(index >= 3 && index <= 8 ? { name: 'FinQuery' } : {}),
  ...(index >= 6 && index <= 8 ? { callMessageIndex: index - 3, preview: fixtures[index - 6].raw } : { preview: '隔离测试材料' }),
  reference: { collectionId: "0_wencai/0_daily_eval", runId: reference.runId, inputId: 'table-input', messageIndex: index },
 })) },
}] };
let sessions, reads = 0, prompts = 0, browser, page;
const tool = { name: 'read_case', readOnly: true, description: 'Read fixture', inputSchema: { type: 'object' }, execute: async () => { reads++; return { content: [{ type: 'text', text: JSON.stringify(material) }] }; } };
const server = await serveAssistant({ port: 0, userId: 'local', webDirectory: process.cwd() + '/dist/agent/web', endpoints: url => assistantEndpoints(sessions = new AssistantSessions({
 directory, url, model: { provider: 'test', model: 'test' }, systemPrompt: 'test', tools: [tool],
 driver: async ({ event }) => ({ async prompt(text) {
  prompts++;
  await event({ type: 'agent_start' }); await event({ type: 'turn_start' });
  await event({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
  await event({ type: 'message_start', message: { role: 'assistant' } });
  await event({ type: 'message_end', message: { role: 'assistant', provider: 'test', model: 'test', content: [{ type: 'toolCall', id: 'case', name: 'read_case', arguments: args }], stopReason: 'toolUse' } });
  await event({ type: 'tool_execution_start', toolCallId: 'case', toolName: 'read_case', args });
  await event({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'case', content: [{ type: 'text', text: JSON.stringify(material) }], details: { sourceRead: { tool: 'read_case', args } }, isError: false } });
  await event({ type: 'turn_end' }); await event({ type: 'turn_start' });
  await event({ type: 'message_start', message: { role: 'assistant' } });
  await event({ type: 'message_end', message: { role: 'assistant', provider: 'test', model: 'test', content: [{ type: 'text', text: '宽表测试已就绪。' }], stopReason: 'stop' } });
  await event({ type: 'turn_end' }); await event({ type: 'agent_end' });
 }, async steer() {}, async abort() {}, async dispose() {} }),
})) });
const results = [], issues = [];
try {
 browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
 page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
 page.on('pageerror', error => issues.push(String(error)));
 await page.goto(server.url);
 const input = page.locator('[contenteditable=true]'); await input.fill('宽表测试'); await input.press('Enter');
 await page.getByText('宽表测试已就绪。', { exact: true }).waitFor();
 const scene = page.locator('[data-case-scene]'), model = scene.locator('[data-case-model]');
 const open = async () => { await scene.locator('summary').first().click(); await model.locator('summary').first().click(); };
 await open();
 const settle = async table => table.evaluate(async table => {
  let last = -1, stable = 0;
  for (let frame = 0; frame < 120 && stable < 6; frame++) {
   await new Promise(resolve => requestAnimationFrame(resolve));
   const position = table.parentElement.scrollLeft;
   stable = position === last ? stable + 1 : 0; last = position;
  }
 });
 for (const fixture of fixtures) {
  await model.getByRole('button', { name: `#${fixture.index} Tool result · FinQuery`, exact: true }).click();
  const table = model.locator('[data-evidence-preview] table'); await table.waitFor();
  const source = [fixture.headers, ...fixture.rows];
  assert.deepEqual(await table.locator('tr').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent))), source);
  for (const width of [1440, 817, 1024, 1440]) {
   await page.setViewportSize({ width, height: 960 }); await table.scrollIntoViewIfNeeded(); await settle(table);
   const checkpoints = [];
   for (const delta of [180, 560, -240, 10000, -10000]) {
    const point = await table.evaluate(table => { const box = table.parentElement.getBoundingClientRect(); return { x: box.right - 20, y: box.top + 20 }; });
    await page.mouse.move(point.x, point.y); await page.mouse.wheel(delta, 0); await settle(table);
    const state = await table.evaluate(table => {
     const scroll = table.parentElement, viewport = scroll.getBoundingClientRect(), headers = [...table.rows[0].cells];
     const fixed = headers.slice(0, 2).map(cell => cell.getBoundingClientRect()), edge = fixed[1].right;
     const visible = headers.slice(2).find(cell => cell.getBoundingClientRect().right > edge + 8);
     const problems = [];
     if (Math.abs(fixed[0].left - viewport.left) > 1 || Math.abs(fixed[1].left - fixed[0].right) > 1) problems.push('fixed columns moved or overlapped');
     if (!visible || Math.abs(visible.getBoundingClientRect().left - edge) > 2) problems.push('partial leading header');
     if (visible && visible.getBoundingClientRect().right > viewport.right + 1) problems.push('leading column cannot fit');
     for (const row of table.rows) {
      const boxes = [...row.cells].map(cell => cell.getBoundingClientRect());
      if (boxes.some(box => Math.abs(box.top - boxes[0].top) > 1 || Math.abs(box.bottom - boxes[0].bottom) > 1)) problems.push('row alignment changed');
      if (visible) {
       const range = document.createRange(); range.selectNodeContents(row.cells[visible.cellIndex]);
       if ([...range.getClientRects()].some(rect => rect.left < edge + 8)) problems.push('text touches fixed divider');
      }
      for (const cell of [...row.cells].filter((_, index) => index !== 1)) {
       const range = document.createRange(); range.selectNodeContents(cell);
       if (new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size > 1) problems.push('code, date or number split across lines');
      }
      for (let index = 0; index < 2; index++) {
       const cell = row.cells[index], box = boxes[index], range = document.createRange(); range.selectNodeContents(cell);
       if (Math.abs(box.left - fixed[index].left) > 1 || [...range.getClientRects()].some(rect => rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) problems.push('identifier text clipped');
       if (box.top >= 80 && box.bottom <= innerHeight - 190 && !cell.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))) problems.push('identifier covered');
      }
     }
     if (document.documentElement.scrollWidth > innerWidth) problems.push('table stretches page');
     return { left: scroll.scrollLeft, maximum: scroll.scrollWidth - scroll.clientWidth, available: viewport.right - edge,
      leading: visible && { heading: visible.textContent, gap: visible.getBoundingClientRect().left - edge },
      problems: [...new Set(problems)], fontSize: getComputedStyle(table.rows[1].cells[0]).fontSize };
    });
    checkpoints.push(state);
    if (state.problems.length || state.fontSize !== '13px') issues.push({ columns: fixture.columns, width, delta, ...state });
   }
   assert(checkpoints.some(state => state.left > 0) && checkpoints.at(-1).left <= 1, 'wheel scrolling traverses the table in both directions');
   assert.deepEqual(await table.locator('tr').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent))), source, 'all evidence cells preserve their row and value after scrolling and resizing');
   results.push({ columns: fixture.columns, width, checkpoints });
  }
  const raw = model.locator('[data-evidence-raw]'); await raw.locator('summary').click();
  assert.equal(await raw.locator('pre').textContent(), fixture.raw); await raw.locator('summary').click();
  await model.getByRole('button', { name: '复制给 Eris', exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.deepEqual(JSON.parse(copied.slice(copied.indexOf('{'))), { reference: { collectionId: "0_wencai/0_daily_eval", runId: reference.runId, inputId: 'table-input', messageIndex: fixture.index }, relatedMessageIndices: [fixture.index - 3] });
  await input.focus(); await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await input.press('Backspace');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  assert.equal(await input.innerText(), copied);
  await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await input.press('Backspace');
  await table.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${shots}/${fixture.columns}-columns.png`, fullPage: true });
 }
 await page.reload(); await page.getByText('宽表测试已就绪。', { exact: true }).waitFor(); await open();
 for (const fixture of fixtures) {
  await model.getByRole('button', { name: `#${fixture.index} Tool result · FinQuery`, exact: true }).click();
  const table = model.locator('[data-evidence-preview] table'); await table.waitFor(); await settle(table);
  assert.deepEqual(await table.locator('tr').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent))), [fixture.headers, ...fixture.rows]);
  assert.equal(await table.getAttribute('data-evidence-identifiers'), '');
 }
 assert.equal(prompts, 1, 'testing never runs another model turn');
 const state = (await sessions.list('local'))[0], journal = await readFile(`${directory}/users/local/sessions/${state.sessionId}/events.jsonl`, 'utf8');
 assert(!journal.includes(fixtures[0].name), 'original tables are not duplicated into the session journal');
 await writeFile(shots + '/results.json', JSON.stringify({ fixtures: fixtures.map(({ columns, raw, name }) => ({ columns, chars: raw.length, nameLength: name.length })), results, issues, reads, prompts }, null, 2));
 assert.deepEqual(issues, []);
 console.log('Wide-table wheel scrolling, resize, source integrity, clipboard and refresh checks passed.');
} catch (error) {
 await writeFile(shots + '/results.json', JSON.stringify({ results, issues }, null, 2));
 if (page) await page.screenshot({ path: shots + '/failure.png', fullPage: true });
 throw error;
} finally { await browser?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
