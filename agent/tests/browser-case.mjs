import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AssistantSessions, serveAssistant } from '@eval/runtime/assistant';
import { assistantEndpoints } from '@eval/assistant/server';

const directory = await mkdtemp(tmpdir() + '/assistant-case-');
const shots = process.cwd() + '/.artifacts/agent-case';
await mkdir(shots, { recursive: true });
const reference = { collectionId: "0_wencai/0_daily_eval", runId: 'run', taskId: 'pair' }, args = { reference };
const recordedReasoning = '原始条件仅命中3只，不足要求的8只。'.repeat(150) + '末尾证据仍保留。';
const longToolName = 'web_search_company_announcements_and_financial_evidence';
const evidenceTable = '|指数代码|指数简称|最新涨跌幅:前复权|最新价|指数类型|成分领域|涨跌幅[20261009]|\n|---|---|---|---|---|---|---|\n|886068.TI|AI视频|5.48%|2159.86点|同花顺概念指数|A股指数|20261009|\n|`885877.TI`|转基因|5.45%|1,920.15|' + '较长的说明保留完整内容并自然换行。'.repeat(8) + '|A股指数|2026-10-09 09:30:00|';
const recordedEvidence = JSON.stringify([{ type: 'input_text', text: '<referencable-result>\nID: 15\n' }, { type: 'input_text', text: '以下是结果：\n已核验两行。\n' + evidenceTable + '\n\n[公告](https://example.com/evidence)\n<script>untrusted</script>' }, { type: 'input_text', text: '</referencable-result>' }]);
const material = { kind: 'case', reference, question: '比较这两份回答是否解决用户问题', answers: ['A组Expert', 'B组Expert'].map((modelName, i) => ({
 modelName, answer: { text: `${modelName}的实际最终回答`, complete: true, reference: { collectionId: "0_wencai/0_daily_eval", runId: 'run', inputId: `input-${i}`, messageIndex: 10 } },
 trace: { messageCount: 11, toolCalls: 3, finalMessageIndex: 10, nodes: [
  { messageIndex: 0, type: 'user_question', role: 'user', chars: 40 },
  { messageIndex: 1, type: 'tool_call', name: 'memory', preview: '{"query":"用户偏好"}', chars: 80 },
  { messageIndex: 2, type: 'tool_result', name: 'memory', callMessageIndex: 1, preview: 'Error: missing argument', chars: 100 },
  { messageIndex: 3, type: 'reasoning', previewKind: 'summary', preview: recordedReasoning, chars: recordedReasoning.length + 80 },
  { messageIndex: 4, type: 'reasoning', chars: 30 },
  { messageIndex: 5, type: 'tool_call', name: longToolName, preview: '{"query":"核实材料"}' },
  { messageIndex: 6, type: 'tool_result', name: longToolName, callMessageIndex: 5, preview: '搜索材料' },
  { messageIndex: 7, type: 'reasoning', preview: '对照来源核验。' },
  { messageIndex: 8, type: 'tool_call', name: 'FinQuery', preview: '{"query":"核对指标"}' },
  { messageIndex: 9, type: 'tool_result', name: 'FinQuery', callMessageIndex: 8, preview: i === 0 ? recordedEvidence : '|项目|结论|证据|日期|\n|---|---|---|---|\n|数量|不足|仅三项|20261009|' },
  { messageIndex: 10, type: 'final_answer', role: 'assistant', chars: 60 },
 ].map(node => ({ ...node, reference: { collectionId: "0_wencai/0_daily_eval", runId: 'run', inputId: `input-${i}`, messageIndex: node.messageIndex } })) },
})) };
let reads = 0, prompts = 0, sessions;
const tool = { name: 'read_case', readOnly: true, description: 'Read case', inputSchema: { type: 'object' },
 execute: async () => { reads++; return { content: [{ type: 'text', text: JSON.stringify(material) }] }; } };
const server = await serveAssistant({ port: 0, userId: 'local', webDirectory: process.cwd() + '/dist/agent/web',
 endpoints: url => assistantEndpoints(sessions = new AssistantSessions({ directory, url, model: { provider: 'test', model: 'test' }, systemPrompt: 'test', tools: [tool],
 driver: async ({ event }) => ({ async prompt(text) {
  prompts++;
  const global = text === '全局分析', deep = text.startsWith('请继续调查这条证据');
  const toolName = deep ? 'read_evidence' : 'read_case', callId = `${deep ? 'evidence-call' : 'case-call'}-${prompts}`;
  const toolArgs = deep ? { reference: { collectionId: "0_wencai/0_daily_eval", runId: 'run', inputId: 'input-0' }, messages: [{ messageIndex: 2 }] } : args;
  await event({ type: 'agent_start' }); await event({ type: 'turn_start' });
  await event({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
  if (!global) {
   await event({ type: 'message_start', message: { role: 'assistant' } });
   await event({ type: 'message_end', message: { role: 'assistant', provider: 'test', model: 'test', content: [{ type: 'toolCall', id: callId, name: toolName, arguments: toolArgs }], stopReason: 'toolUse' } });
   await event({ type: 'tool_execution_start', toolCallId: callId, toolName, args: toolArgs });
   await event({ type: 'message_end', message: { role: 'toolResult', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(deep ? { kind: 'evidence', items: [] } : material) }], details: { sourceRead: { tool: toolName, args: toolArgs } }, isError: false } });
   await event({ type: 'turn_end' }); await event({ type: 'turn_start' });
  }
  await event({ type: 'message_start', message: { role: 'assistant' } });
  await event({ type: 'message_end', message: { role: 'assistant', provider: 'test', model: 'test', content: [{ type: 'text', text: global ? '全局分析完成。' : deep ? '原始证据核对完成。' : '案例分析完成。\n\n参考：[公告](https://example.com/source)。' }], stopReason: 'stop' } });
  await event({ type: 'turn_end' }); await event({ type: 'agent_end' });
 }, async steer() {}, async abort() {}, async dispose() {} }),
 })) });
let browser, page;
try {
 browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
 page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
 const errors = [];
 page.on('pageerror', error => errors.push(String(error)));
 await page.goto(server.url);
 const input = page.locator('[contenteditable=true]'); await input.waitFor(); await input.fill('分析一个案例'); await input.press('Enter');
 await page.getByText('案例分析完成。', { exact: true }).waitFor();
 assert.equal(reads, 0, 'collapsed tools do not reread source material');
 await page.getByText('参考：公告。', { exact: true }).waitFor();
 assert.equal(await page.getByRole('link', { name: '公告', exact: true }).count(), 0);
 const openScene = async () => {
  const scene = page.locator('[data-case-scene]').first();
  await scene.getByText('链路小现场', { exact: true }).click();
  const models = scene.locator('[data-case-model]');
  await models.first().waitFor();
  assert.equal(await models.count(), 2);
  await models.first().locator('summary').first().click();
  assert.equal(await models.nth(1).evaluate(node => node.open), false);
  await models.first().getByRole('button', { name: '#2 Tool result · memory', exact: true }).click();
  await models.first().locator('[data-evidence-preview]').getByText('Error: missing argument', { exact: true }).waitFor();
  assert.equal(await models.first().locator('svg[data-trace-flow]').count(), 1);
  assert.equal(await models.first().getByRole('button', { name: '#1 Tool call · memory', exact: true }).locator('foreignObject div').innerText(), 'Tool call · memory');
  assert.equal(await models.first().getByRole('button', { name: '#2 Tool result · memory', exact: true }).locator('foreignObject div').innerText(), 'Tool result · memory');
  assert.doesNotMatch(await models.first().locator('svg[data-trace-flow]').textContent(), /源记录|字符/);
  assert.equal(await models.first().locator('[data-flow-edge=order]').count(), 10);
  assert.equal(await models.first().locator('[data-flow-edge=call][data-from="1"][data-to="2"]').count(), 1);
  const overview = await models.first().locator('[data-trace-viewport]').evaluate(pane => {
   const bounds = pane.getBoundingClientRect(), selected = pane.querySelector('[aria-pressed=true]').getBoundingClientRect();
   return { height: bounds.height, scrollable: pane.scrollHeight > pane.clientHeight + 1,
    selectedVisible: selected.top >= bounds.top + 20 && selected.bottom <= bounds.bottom,
    nodes: pane.querySelectorAll('[role=button]').length,
    fontSize: parseFloat(getComputedStyle(pane.querySelector('foreignObject div')).fontSize) };
  });
  assert(overview.height <= 240, 'short evidence keeps the scene compact instead of stretching to the whole chain');
  assert(overview.scrollable && overview.selectedVisible, 'the compact flow keeps the selected node visible');
  assert.equal(overview.nodes, 11, 'compact presentation retains every node');
  assert(overview.fontSize >= 13, 'compact presentation does not shrink labels');
  const connector = await models.first().locator('[data-flow-edge=call]').evaluate(edge => {
   const svg = edge.closest('svg'), from = svg.querySelector('[aria-label^="#1 "] rect'), to = svg.querySelector('[aria-label^="#2 "] rect');
   const start = edge.getPointAtLength(0), end = edge.getPointAtLength(edge.getTotalLength());
   const afterStart = edge.getPointAtLength(2), beforeEnd = edge.getPointAtLength(edge.getTotalLength() - 2);
   const fromBox = from.getBBox(), toBox = to.getBBox(), bounds = edge.getBBox();
   return { startX: start.x, startY: start.y, endX: end.x, endY: end.y, afterStartY: afterStart.y, beforeEndY: beforeEnd.y,
    fromRight: fromBox.x + fromBox.width, fromCenter: fromBox.y + fromBox.height / 2, toRight: toBox.x + toBox.width, toCenter: toBox.y + toBox.height / 2,
    right: bounds.x + bounds.width, width: svg.viewBox.baseVal.width };
  });
  assert.equal(connector.startY, connector.fromCenter);
  assert.equal(connector.endY, connector.toCenter);
  assert.equal(connector.afterStartY, connector.startY);
  assert.equal(connector.beforeEndY, connector.endY);
  assert(connector.startX >= connector.fromRight + 4 && connector.endX >= connector.toRight + 6);
  assert(connector.right <= connector.width - 16, 'association stays outside nodes with a clear right margin');
  await models.first().getByRole('button', { name: '复制给 Eris', exact: true }).click();
  await models.first().getByRole('button', { name: '已复制', exact: true }).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /A组Expert/);
  assert.deepEqual(JSON.parse(copied.slice(copied.indexOf('{'))), { reference: { collectionId: "0_wencai/0_daily_eval", runId: 'run', inputId: 'input-0', messageIndex: 2 }, relatedMessageIndices: [1] });
  await models.first().getByRole('button', { name: '来自调用 #1', exact: true }).click();
  assert.deepEqual(JSON.parse(await models.first().locator('[data-evidence-preview]').textContent()), { query: '用户偏好' });
  assert.equal(await models.first().getByText('A组Expert的实际最终回答', { exact: true }).count(), 0);
  await models.first().getByRole('button', { name: '#3 Reasoning', exact: true }).click();
  assert.equal(await models.first().getByText('源记录仅含摘要', { exact: true }).count(), 0);
  assert.equal(await models.first().locator('[data-evidence-preview]').textContent(), recordedReasoning);
  const panels = await models.first().locator('[data-case-workspace]').evaluate(workspace => {
   const flow = workspace.querySelector('[data-trace-flow]').parentElement.getBoundingClientRect();
   const evidence = workspace.querySelector('[data-case-evidence]').getBoundingClientRect();
   return { topGap: evidence.top - flow.top, flowHeight: flow.height, evidenceHeight: evidence.height };
  });
  assert(Math.abs(panels.topGap) <= 1 && panels.evidenceHeight > overview.height && panels.flowHeight <= panels.evidenceHeight + 1, 'long evidence expands the scene while the flow stays within it: ' + JSON.stringify(panels));
  assert(panels.flowHeight < 600, 'long evidence does not stretch the compact flow');
  await models.first().getByRole('button', { name: '#4 Reasoning', exact: true }).click();
  await models.first().getByText('源记录未提供推理正文或摘要', { exact: true }).waitFor();
  await models.first().getByRole('button', { name: '#9 Tool result · FinQuery', exact: true }).click();
  const readable = models.first().locator('[data-evidence-preview]'), raw = models.first().locator('[data-evidence-raw]');
  await readable.locator('table').waitFor();
  assert.equal(await readable.locator('tbody tr').count(), 2);
  assert.equal(await readable.locator('th').count(), 7);
  for (const width of [817, 1440]) {
   await page.setViewportSize({ width, height: 960 });
   await readable.locator('table').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
   const layout = await readable.locator('table').evaluate(table => {
    const lines = cell => {
     const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT), tops = new Set();
     while (walker.nextNode()) { const range = document.createRange(); range.selectNodeContents(walker.currentNode); for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top)); }
     return tops.size;
    };
    const cells = [...table.querySelectorAll('th, td')], longText = table.rows[2].cells[4], scroll = table.parentElement;
    return { split: cells.filter(cell => cell !== longText && lines(cell) !== 1).map(cell => cell.textContent), longTextLines: lines(longText),
     fontSize: getComputedStyle(table.rows[1].cells[0]).fontSize, codeFontSize: getComputedStyle(table.querySelector('code')).fontSize,
     scrollable: scroll.scrollWidth > scroll.clientWidth, overflowX: getComputedStyle(scroll).overflowX,
     pageFits: document.documentElement.scrollWidth <= innerWidth };
   });
   assert.deepEqual(layout.split, [], 'codes, numbers, dates and headings stay on one line at ' + width);
   assert(layout.longTextLines > 1, 'long text wraps instead of creating an excessively wide column');
   assert.equal(layout.fontSize, '13px');
   assert.equal(layout.codeFontSize, '13px');
   assert(layout.scrollable && ['auto', 'scroll'].includes(layout.overflowX), 'wide evidence scrolls within its own table');
   assert(layout.pageFits, 'wide tables never stretch the page');
   const frozen = await readable.locator('table').evaluate(table => {
    const scroll = table.parentElement;
    const positions = () => [...table.rows].map(row => [...row.cells].slice(0, 3).map(cell => {
     const box = cell.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top };
    }));
    const before = positions(); scroll.scrollLeft = scroll.scrollWidth;
    const after = positions(), scrolled = scroll.scrollLeft;
    const visible = [...table.rows].every(row => [...row.cells].slice(0, 2).every(cell => {
     const box = cell.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
     return cell.contains(hit) && getComputedStyle(cell).backgroundColor === 'rgb(255, 255, 255)';
    }));
    scroll.scrollLeft = 0;
    return { before, after, scrolled, visible };
   });
   assert(frozen.scrolled > 0 && frozen.visible, 'both identifier columns remain visible above the scrolling data');
   frozen.before.forEach((row, index) => {
    const after = frozen.after[index];
    assert(Math.abs(after[0].left - row[0].left) <= 1 && Math.abs(after[1].left - row[1].left) <= 1, 'code and name stay fixed in every row');
    assert(Math.abs(after[0].right - after[1].left) <= 1, 'fixed columns meet without a gap or overlap');
    assert(Math.abs(after[2].left - row[2].left + frozen.scrolled) <= 1 && after[2].top === row[2].top, 'remaining cells scroll horizontally and keep row alignment');
   });
   for (const fraction of [0.23, 0.61, 1]) {
    const boundary = await readable.locator('table').evaluate(async (table, fraction) => {
     const scroll = table.parentElement;
     scroll.scrollLeft = (scroll.scrollWidth - scroll.clientWidth) * fraction;
     await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
     const edge = table.rows[0].cells[1].getBoundingClientRect().right;
     const visible = [...table.rows[0].cells].slice(2).find(cell => cell.getBoundingClientRect().right > edge + 8);
     const index = visible.cellIndex, cells = [...table.rows].map(row => row.cells[index]);
     return { heading: visible.textContent, leftGap: visible.getBoundingClientRect().left - edge,
      textGaps: cells.map(cell => { const range = document.createRange(); range.selectNodeContents(cell); return Math.min(...[...range.getClientRects()].map(rect => rect.left)) - edge; }) };
    }, fraction);
    assert(boundary.leftGap >= -1 && boundary.leftGap <= 1, 'scrolling settles at a whole column: ' + JSON.stringify(boundary));
    assert(boundary.textGaps.every(gap => gap >= 15), 'header and row text keep clear of the fixed divider');
   }
   await readable.locator('table').evaluate(table => { table.parentElement.scrollLeft = 0; });
  }
  assert.match(await readable.innerText(), /ID: 15/);
  assert.equal(await readable.getByText('以下是结果：\n已核验两行。', { exact: true }).evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap');
  assert.doesNotMatch(await readable.innerText(), /input_text|referencable-result/);
  assert.equal(await readable.locator('a[href], script, img').count(), 0, 'source HTML stays inert and external references are plain text');
  assert.equal(await raw.evaluate(el => el.open), false);
  await raw.locator('summary').click();
  assert.equal(await raw.locator('pre').textContent(), recordedEvidence, 'raw data retains every source character');
  await raw.locator('summary').click();
  await models.first().getByRole('button', { name: '复制给 Eris', exact: true }).click();
  const tableReference = await page.evaluate(() => navigator.clipboard.readText());
  assert.deepEqual(JSON.parse(tableReference.slice(tableReference.indexOf('{'))), { reference: { collectionId: "0_wencai/0_daily_eval", runId: 'run', inputId: 'input-0', messageIndex: 9 }, relatedMessageIndices: [8] });
  assert(!tableReference.includes('886068.TI'), 'copying follows original coordinates, not rendered text');
  await page.screenshot({ path: shots + '/evidence-desktop.png', fullPage: true });
  await models.nth(1).locator('summary').first().click();
  await models.nth(1).getByRole('button', { name: '#9 Tool result · FinQuery', exact: true }).click();
  await models.nth(1).locator('[data-evidence-preview] table').waitFor();
  assert.equal(await models.nth(1).locator('[data-evidence-identifiers]').count(), 0, 'unrelated tables do not freeze arbitrary columns');
  await models.nth(1).locator('summary').first().click();
  await models.first().locator('summary').first().click();
  await models.first().getByRole('button', { name: `#6 Tool result · ${longToolName}`, exact: true }).click();
  assert.deepEqual(await models.first().locator('[data-trace-label]').evaluateAll(nodes => nodes.filter(n => {
   const text = n.getBoundingClientRect(), container = n.parentElement.getBoundingClientRect();
   return n.scrollWidth > n.clientWidth || text.bottom > container.bottom + 1;
  }).map(n => n.textContent)), [], 'full tool labels fit horizontally and vertically, including long unbroken names');
  assert(await models.first().getByRole('button', { name: `#6 Tool result · ${longToolName}`, exact: true }).evaluate(el => {
   const box = el.querySelector('rect').getBoundingClientRect(), pane = el.closest('[data-trace-viewport]').getBoundingClientRect();
   return box.height > 50 && box.top >= pane.top + 20 && box.bottom <= pane.bottom;
  }), 'a selected multi-line tool label expands its node and stays visible');
  await models.first().getByRole('button', { name: '#10 Final answer', exact: true }).click();
  await models.first().locator('[data-evidence-preview]').getByText('A组Expert的实际最终回答', { exact: true }).waitFor();
  await models.first().getByRole('button', { name: '#2 Tool result · memory', exact: true }).click();
  await models.first().getByRole('button', { name: '复制给 Eris', exact: true }).click();
  await page.screenshot({ path: shots + '/scene-desktop.png', fullPage: true });
  const loadedReads = reads;
  assert.deepEqual(await scene.evaluate(el => ({ shadow: getComputedStyle(el).boxShadow, background: getComputedStyle(el).backgroundColor })), { shadow: 'none', background: 'rgba(0, 0, 0, 0)' });
  await scene.getByText('链路小现场', { exact: true }).click();
  await scene.getByText('链路小现场', { exact: true }).click();
  assert.equal(reads, loadedReads, 'reopening a mounted scene does not reread');
  await scene.getByText('链路小现场', { exact: true }).click();
 };
 await openScene();
 const open = async () => {
  const row = page.getByRole('button', { name: /读取案例/ }).first();
  if (!(await row.isVisible())) {
   await page.locator('[data-turn-process]').click();
   const activity = page.locator('[data-process-activity][aria-expanded=false]').first();
   if (await activity.count()) await activity.click();
  }
  if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
  await page.getByText(material.question, { exact: true }).waitFor();
  const maps = page.locator('summary').filter({ hasText: '链路地图（11 个节点）' });
  assert.equal(await maps.count(), 2);
  await maps.first().click();
  await page.getByText('2 · Tool result · memory', { exact: true }).first().waitFor();
  assert.equal(await maps.nth(1).evaluate(node => node.parentElement.open), false, 'each model map expands independently');
  await page.getByText('Error: missing argument', { exact: true }).first().waitFor();
  const answer = page.locator('summary').filter({ hasText: /^Final answer$/ }).first();
  await answer.click();
  await page.getByText('A组Expert的实际最终回答', { exact: true }).waitFor();
  await answer.click();
  await page.getByText('2 · Tool result · memory', { exact: true }).first().scrollIntoViewIfNeeded();
 };
 await open();
 const state = (await sessions.list('local'))[0];
 const journal = await readFile(`${directory}/users/local/sessions/${state.sessionId}/events.jsonl`, 'utf8');
 assert(!journal.includes('A组Expert的实际最终回答'), 'original answer bodies remain in the data source');
 assert(journal.includes('sourceRead'));
 await page.screenshot({ path: shots + '/case-desktop.png', fullPage: true });
 await page.reload(); await page.getByText('案例分析完成。', { exact: true }).waitFor();
 assert.equal(await page.getByRole('link', { name: '公告', exact: true }).count(), 0);
 await openScene(); await open();
 assert.equal(prompts, 1, 'refresh never reruns the model or its tools');
 const previousReads = reads;
 await input.focus(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
 assert.match(await input.innerText(), /请继续调查这条证据/);
 await input.press('Enter');
 await page.getByText('原始证据核对完成。', { exact: true }).waitFor();
 assert.equal(await page.locator('[data-case-scene]').count(), 2, 'follow-up has its own direct scene entry');
 assert.equal(reads, previousReads, 'follow-up entry stays lazy');
 const followup = page.locator('[data-case-scene]').last();
 await followup.getByText('链路小现场', { exact: true }).click();
 await followup.locator('[data-case-model]').waitFor();
 assert.equal(await followup.locator('[data-case-model]').count(), 1, 'follow-up shows the exact referenced model');
 assert.equal(await followup.locator('[data-case-model]').getAttribute('data-case-model'), 'A组Expert');
 await input.fill('全局分析'); await input.press('Enter');
 await page.getByText('全局分析完成。', { exact: true }).waitFor();
 assert.equal(await page.locator('[data-case-scene]').count(), 2, 'global reply adds no scene');
 const longAnswer = material.answers[0];
 const completeAnswer = 'A组Expert的完整最终回答。'.repeat(200);
 longAnswer.answer.text = completeAnswer;
 longAnswer.answer.reference.messageIndex = 100;
 longAnswer.trace = { finalMessageIndex: 100, messageCount: 101, toolCalls: 1, nodes: Array.from({ length: 101 }, (_, messageIndex) => ({
  messageIndex, type: messageIndex === 0 ? 'user_question' : messageIndex === 1 ? 'tool_call' : messageIndex === 99 ? 'tool_result' : messageIndex === 100 ? 'final_answer' : 'reasoning',
  ...(messageIndex === 100 ? { previewTruncated: true } : {}),
  ...(messageIndex === 1 || messageIndex === 99 ? { name: 'Search' } : {}), ...(messageIndex === 99 ? { callMessageIndex: 1 } : {}),
  preview: messageIndex === 1 ? '原始查询' : '完整证据。'.repeat(300), reference: { collectionId: "0_wencai/0_daily_eval", runId: 'run', inputId: 'input-0', messageIndex },
 })) };
 await input.fill('分析长链路'); await input.press('Enter');
 const longScene = page.locator('[data-case-scene]').nth(2);
 await longScene.waitFor();
 await longScene.locator('summary').first().click();
 const longModel = longScene.locator('[data-case-model]').first();
 await longModel.locator('summary').first().click();
 const pane = longModel.locator('[data-trace-viewport]');
 await longModel.getByRole('button', { name: '#100 Final answer', exact: true }).click();
 await longModel.locator('[data-evidence-preview]').getByText(completeAnswer, { exact: true }).waitFor();
 assert.equal(await longModel.locator('[data-case-evidence]').getByText(/预览已截断/).count(), 0, 'a fully loaded final answer must not inherit truncation from its shorter map preview');
 const capped = await pane.evaluate(el => ({ height: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop,
  count: el.querySelectorAll('[role=button]').length, font: getComputedStyle(el.querySelector('foreignObject div')).fontSize }));
 assert(capped.height <= 560 && capped.scrollHeight > 4000 && capped.scrollTop > 3000, JSON.stringify(capped));
 assert.equal(capped.count, 101, 'height cap never removes trace nodes');
 assert.equal(capped.font, '13px');
 await longModel.getByRole('button', { name: '#99 Tool result · Search', exact: true }).click();
 await longModel.getByRole('button', { name: '复制给 Eris', exact: true }).click();
 assert.deepEqual(JSON.parse((await page.evaluate(() => navigator.clipboard.readText())).split('\n').slice(3).join('\n')),
  { reference: { collectionId: "0_wencai/0_daily_eval", runId: 'run', inputId: 'input-0', messageIndex: 99 }, relatedMessageIndices: [1] });
 await longModel.locator('[data-case-evidence]').evaluate(el => { el.scrollTop = 500; });
 await longModel.getByRole('button', { name: '来自调用 #1', exact: true }).click();
 await longModel.locator('[data-evidence-preview]').getByText('原始查询', { exact: true }).waitFor();
 assert(await pane.evaluate(el => {
  const selected = el.querySelector('[aria-pressed=true]').getBoundingClientRect(), box = el.getBoundingClientRect();
  return selected.top >= box.top + 20 && selected.bottom <= box.bottom && el.scrollTop < 100;
 }), 'source navigation brings the selected node below the sticky legend');
 assert.equal(await longModel.locator('[data-case-evidence]').evaluate(el => el.scrollTop), 0, 'a different node starts at the top of its evidence');
 assert(await pane.evaluate(el => el.clientHeight <= 240), 'returning to a short call shrinks the scene after long evidence');
 await page.setViewportSize({ width: 1024, height: 720 });
 assert(await pane.evaluate(el => el.clientHeight <= innerHeight * .65 + 1));
 await longScene.locator('[data-case-model]').nth(1).locator('summary').first().click();
 assert.equal(await longModel.evaluate(el => el.open), false, 'one model unfolds at a time so the scene stays bounded');
 assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
 assert.deepEqual(errors, []);
 console.log('Desktop case answer, trace disclosure, source-only persistence and refresh checks passed.');
} catch (error) {
 if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: shots + '/failure.png', fullPage: true }); }
 throw error;
} finally { await browser?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
