import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AssistantSessions, serveAssistant } from '@eval/runtime/assistant';
import { assistantEndpoints } from '@eval/assistant/server';

const examples = [
  { title: '通鼎互联震荡还会持续多久', candidates: [
    { model: 'a_expert', name: 'A组Expert', outcome: 'win', summary: '预计还会震荡1–3周。', paths: [
      { title: '时间参考', evidence: 'A按不同走势给出对应的持续时间范围。', impact: '可对照走势理解时间范围的适用条件。', assessment: 'strength' },
      { title: '预测依据', evidence: '未核验周线，9月走势描述与公告冲突。', impact: '1–3周的具体时长缺乏充分依据。', assessment: 'problem' },
    ] },
    { model: 'b_expert', name: 'B组Expert', outcome: 'loss', summary: '预计10月中下旬企稳。', paths: [
      { title: '交易日计数', evidence: '实际仅5个交易日，却按8个交易日推算。', impact: '企稳日期的推算依据出错。', assessment: 'problem', highlights: { evidence: '按8个交易日' } },
      { title: '支撑位判断', evidence: '用报错的9月15日低点推算支撑位。', impact: '支撑位缺少可靠的价格依据。', assessment: 'problem' },
      { title: '两融余额', evidence: '用高估10倍的两融余额支撑资金判断。', impact: '资金支撑强度被夸大。', assessment: 'problem' },
    ] },
  ], verdict: 'A组Expert胜', reason: 'A给出了分情景的持续时间；B对企稳时点和支撑位的推断存在直接的数据错误。', caveat: '2026-10-10 · Expert · 单场比较 · 未提供标准答案' },
  { title: '中国船舶当前的 EMA20 是多少', candidates: [
    { model: 'b_expert', name: 'B组Expert', outcome: 'both_good', summary: '给出9月30日 EMA20 为38.192元。', paths: [
      { title: '核心数值', evidence: 'B给出9月30日 EMA20 为38.192元。', impact: '用户能使用这个日期对应的数值。', assessment: 'strength' },
    ] },
    { model: 'a_expert', name: 'A组Expert', outcome: 'both_good', summary: '给出9月30日 EMA20 为38.192元。', paths: [
      { title: '核心数值', evidence: 'A同样给出9月30日的38.192元。', impact: '核心数值与日期没有差异。', assessment: 'strength' },
      { title: '当前口径', evidence: 'A沿用9月30日的结果，未提供当前时点的计算依据。', impact: '该数值是否适用于当前，仍待确认。', assessment: 'uncertain' },
    ] },
  ], verdict: '双方均好', reason: '核心数值和日期一致', caveat: '对比口径：9月30日 EMA20' },
  { title: '根据当前行情和财报，后续走势如何', candidates: [
    { model: 'a_expert', name: 'A组Expert', outcome: 'both_bad', summary: '用当天收盘价作为走势预测的依据。', paths: [
      { title: '可知时点', evidence: 'A在05:44就把当天收盘价当作已有依据。', impact: '预测无法由当时可用的行情材料支持。', assessment: 'problem' },
    ] },
    { model: 'b_expert', name: 'B组Expert', outcome: 'both_bad', summary: '用财报信息作为走势预测的依据。', paths: [
      { title: '财报时点', evidence: 'B把尚未发布的财报当作已公布信息。', impact: '预测无法由当时可用的财报材料支持。', assessment: 'problem' },
    ] },
  ], verdict: '双方均差', reason: '双方都用了提问时点尚不可得的信息，预测缺少当时可用材料支持。', reasonHighlight: '当时可用材料' },
];
const report = `**A组Expert胜。** A给出了分情景的持续时间；B的时点和支撑位推断存在直接的数据错误。\n\n- **胜负差异：** B的交易日计数和低点错误，分别影响企稳时点与支撑位推断。\n- **具体范围：** A的预测既缺周线核验，也用了与公告冲突的行情描述；这些材料不足以支持用户把1–3周作为可靠时长。\n\n| 对比项 | A组Expert | B组Expert | 判断 |\n| --- | --- | --- | --- |\n| 时间范围 | **✅已回应**：给出1–3周及条件 | **❌计数错误**：按8个交易日推算，实际5个 | B的时间依据失真 |\n| 周线依据 | **⚠️待核实**：未完成核验 | **⚠️材料未说明** | 暂不能比较 |\n| 资金数据 | ⚠️材料未说明 | **❌数量级错误**：两融余额高估10倍 | B的资金规模判断失真 |`;
const failedPrompt = '失败回执';
const directory = await mkdtemp(tmpdir() + '/eris-diagrams-');
const shots = process.cwd() + '/.artifacts/agent-diagrams';
await mkdir(shots, { recursive: true });
const streamGate = Promise.withResolvers();
let executions = 0, receipts = 0;
const comparisonTool = { name: 'show_comparison', description: '显示正式对照', readOnly: true, inputSchema: { type: 'object' },
  execute: async diagram => { receipts++; return { content: [{ type: 'text', text: JSON.stringify({ kind: 'comparison-diagram', diagram }) }] }; } };
const server = await serveAssistant({ port: 0, userId: 'local', webDirectory: process.cwd() + '/dist/agent/web',
  endpoints: url => assistantEndpoints(new AssistantSessions({ directory, url, model: { provider: 'test', model: 'test' },
    systemPrompt: 'test', tools: [comparisonTool], driver: async ({ event }) => ({
      async prompt(name) {
        const failed = name === failedPrompt, example = examples.find(example => example.title === name) ?? (failed ? examples[0] : null);
        assert(example, 'the fake driver receives a known comparison request');
        const callId = `comparison-${++executions}`;
        const args = { reference: { runId: 'fixture', taskId: callId }, title: name,
          candidates: example.candidates.map(({ model, summary, paths }) => ({ model, summary, paths })), reason: example.reason,
          ...(example.reasonHighlight ? { reasonHighlight: example.reasonHighlight } : {}) };
        await event({ type: 'agent_start' }); await event({ type: 'turn_start' });
        await event({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: name }] } });
        await event({ type: 'message_start', message: { role: 'assistant' } });
        await event({ type: 'message_end', message: { role: 'assistant', provider: 'test', model: 'test',
          content: [{ type: 'toolCall', id: callId, name: 'show_comparison', arguments: args }], stopReason: 'toolUse' } });
        await event({ type: 'tool_execution_start', toolCallId: callId, toolName: 'show_comparison', args });
        await event({ type: 'message_end', message: { role: 'toolResult', toolCallId: callId,
          ...await comparisonTool.execute(example), isError: failed } });
        await event({ type: 'turn_end' }); await event({ type: 'turn_start' });
        await event({ type: 'message_start', message: { role: 'assistant' } });
        const answer = `### ${name}已完成\n\n${failed ? '对比图未生成。' : example === examples[0] ? report : '按正式判词解释本场差异。'}`;
        await event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: answer } });
        if (executions === 1) await streamGate.promise;
        await event({ type: 'message_end', message: { role: 'assistant', provider: 'test', model: 'test',
          content: [{ type: 'text', text: answer }], stopReason: 'stop' } });
        await event({ type: 'turn_end' }); await event({ type: 'agent_end' });
      }, async steer() {}, async abort() { streamGate.resolve(); }, async dispose() {},
    }),
  })),
});

const dark = color => { const rgb = color?.match(/[\d.]+/g)?.slice(0, 3).map(Number); return rgb?.length === 3 && rgb.every(value => value < 150); };
async function inspectDiagram(visual, example) {
  const figure = visual.locator('[data-analysis-comparison]');
  await figure.locator('[data-comparison-arrow]').first().waitFor({ state: 'attached' });
  assert.equal(await figure.locator('svg').count(), 2, 'the fixed template has just one short answer-to-usefulness arrow per candidate');
  assert.equal(await figure.locator('[data-comparison-question]').textContent(), example.title);
  assert.equal(await figure.getByText('用户问了什么', { exact: true }).count(), 1);
  assert.equal(await figure.getByText('回答给了什么', { exact: true }).count(), 1);
  assert.equal(await figure.getByText('对用户有什么用', { exact: true }).count(), 1);
  assert.deepEqual(await figure.locator('[data-comparison-slice]').evaluateAll(nodes => nodes.map(node => node.dataset.comparisonSlice)), ['question', 'answer', 'usefulness']);
  assert.deepEqual(await figure.locator('[data-comparison-name]').evaluateAll(nodes => nodes.map(node => [node.dataset.comparisonName, node.textContent])),
    example.candidates.map(candidate => [candidate.model, candidate.name]), 'facts stay with their recorded identities and order');
  for (const candidate of example.candidates) {
    const lane = figure.locator(`[data-comparison-candidate="${candidate.model}"]`);
    const answer = figure.locator(`[data-comparison-answer="${candidate.model}"]`);
    assert.equal(await answer.locator('[data-comparison-outcome]').getAttribute('data-comparison-outcome'), candidate.outcome);
    assert.equal(await answer.locator('[data-comparison-summary] [data-comparison-content]').textContent(), candidate.summary);
    assert.equal(await lane.locator('[data-comparison-usefulness]').textContent(), candidate.name);
    assert.equal(await lane.locator('[data-comparison-path]').count(), candidate.paths.length);
    for (const [index, path] of candidate.paths.entries()) {
      const branch = lane.locator('[data-comparison-path]').nth(index);
      assert.equal(await branch.locator('[data-comparison-path-title]').textContent(), path.title);
      assert.equal(await branch.locator('[data-comparison-assessment]').getAttribute('data-comparison-assessment'), path.assessment);
      assert.deepEqual(await branch.locator('[data-comparison-stage]').evaluateAll(nodes => nodes.map(node => [node.dataset.comparisonStage, node.querySelector('[data-comparison-content]').textContent])),
        [['evidence', path.evidence], ['impact', path.impact]]);
      assert.equal(await branch.locator('[data-comparison-support]').textContent(), path.evidence);
      for (const stage of ['evidence', 'impact']) assert.deepEqual(await branch.locator(`[data-comparison-stage="${stage}"] [data-comparison-highlight]`).allTextContents(),
        path.highlights?.[stage] ? [path.highlights[stage]] : [], 'only requested original phrases receive emphasis');
    }
  }
  assert.equal(await figure.locator('[data-comparison-verdict]').textContent(), example.verdict);
  assert.equal(await figure.locator('[data-comparison-reason]').textContent(), example.reason);
  assert.deepEqual(await figure.locator('[data-comparison-reason] [data-comparison-highlight]').allTextContents(), example.reasonHighlight ? [example.reasonHighlight] : []);
  assert(await figure.locator('[data-comparison-highlight]').count() <= 2, 'yellow emphasis is limited to two phrases across the complete diagram');
  if (example.caveat) assert.equal(await visual.locator('[data-comparison-caveat]').textContent(), example.caveat);
  else assert.equal(await visual.locator('[data-comparison-caveat]').count(), 0);
  assert.equal(await figure.locator('[data-comparison-caveat]').count(), 0, 'limitations remain outside the judgment path');
  assert.equal(await visual.locator('[data-comparison-caveat] svg').count(), 0);
  assert.equal(await visual.locator(':scope > p').count(), example.caveat ? 1 : 0, 'the footer contains only the supplied scope note');
  const geometry = await visual.evaluate(element => {
    const figure = element.querySelector('[data-analysis-comparison]');
    const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const read = selector => [...element.querySelectorAll(selector)].map(node => ({ text: node.textContent, fontSize: parseFloat(getComputedStyle(node).fontSize), ...box(node) }));
    return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, figure: box(figure),
      compact: getComputedStyle(element.querySelector('.eris-comparison-transitions')).display === 'none',
      slices: read('[data-comparison-slice]'), answers: read('[data-comparison-answer]'),
      candidates: read('[data-comparison-candidate]'), summaries: read('[data-comparison-summary]'),
      candidateEnds: [...element.querySelectorAll('[data-comparison-candidate]')].map(candidate => ({
        bottom: box(candidate).bottom, lastPathBottom: box(candidate.querySelector('[data-comparison-path]:last-child')).bottom,
        inset: parseFloat(getComputedStyle(candidate).paddingBottom) + parseFloat(getComputedStyle(candidate).borderBottomWidth) })),
      answerFlows: [...element.querySelectorAll('[data-comparison-candidate]')].map(candidate => ({
        answer: box(element.querySelector(`[data-comparison-answer="${candidate.dataset.comparisonCandidate}"]`)),
        arrow: box(element.querySelector(`[data-comparison-arrow="${candidate.dataset.comparisonCandidate}"]`)), usefulness: box(candidate) })),
      paths: [...element.querySelectorAll('[data-comparison-path]')].map(path => ({ ...box(path),
        paragraphs: [...path.querySelectorAll('p')].map(node => ({ ...box(node), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
          scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, weight: parseFloat(getComputedStyle(node).fontWeight) })) })),
      timePhrases: [...element.querySelectorAll('.eris-comparison-value')].filter(node => ['1–3周', '10月中下旬'].includes(node.textContent))
        .map(node => ({ text: node.textContent, ...box(node), lineHeight: parseFloat(getComputedStyle(node).lineHeight) })),
      texts: read('[data-comparison-question],.eris-comparison-slice-number,[data-comparison-slice-title],[data-comparison-name],[data-comparison-outcome],[data-comparison-usefulness],[data-comparison-path-title],[data-comparison-assessment],[data-comparison-support],.eris-comparison-impact,[data-comparison-summary],[data-comparison-verdict],[data-comparison-reason],[data-comparison-caveat]'),
      highlights: [...element.querySelectorAll('[data-comparison-highlight]')].map(node => ({ text: node.textContent, weight: parseFloat(getComputedStyle(node).fontWeight),
        background: getComputedStyle(node).backgroundColor, parent: box(node.closest('[data-comparison-support],.eris-comparison-impact,[data-comparison-reason]')),
        fragments: [...node.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })) })),
      surfaces: [...element.querySelectorAll('[data-comparison-question],[data-comparison-answer],[data-comparison-candidate]')].map(node => getComputedStyle(node).backgroundColor),
      states: [...element.querySelectorAll('[data-comparison-outcome],[data-comparison-assessment]')].map(node => ({ state: node.dataset.comparisonOutcome ?? node.dataset.comparisonAssessment, text: node.textContent, color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor })),
      verdict: box(element.querySelector('[data-comparison-conclusion]')), caveat: element.querySelector('[data-comparison-caveat]') ? box(element.querySelector('[data-comparison-caveat]')) : null,
      arrows: [...figure.querySelectorAll('[data-comparison-arrow]')].filter(arrow => arrow.getClientRects().length > 0).map(arrow => ({ id: arrow.dataset.comparisonArrow, source: arrow.dataset.comparisonSource, target: arrow.dataset.comparisonTarget, ...box(arrow),
        branch: arrow.closest('[data-comparison-path]')?.dataset.comparisonPath,
        shafts: [...arrow.querySelectorAll('path:not([data-arrow-head])')].map(path => ({ stroke: getComputedStyle(path).stroke, width: parseFloat(getComputedStyle(path).strokeWidth),
          points: [0, 0.5, 1].map(fraction => { const point = path.getPointAtLength(path.getTotalLength() * fraction); return { x: point.x, y: point.y }; }) })),
        heads: [...arrow.querySelectorAll('[data-arrow-head]')].map(path => getComputedStyle(path).fill) })),
    };
  });
  assert(geometry.texts.every(node => node.fontSize >= 14), 'all comparison text remains at least 14px');
  for (let i = 0; i < geometry.texts.length; i++) for (const b of geometry.texts.slice(i + 1)) {
    const a = geometry.texts[i];
    assert(Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 || Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1,
      `comparison labels do not overlap: ${a.text} / ${b.text}`);
  }
  assert(geometry.pageWidth <= geometry.width + 1 && geometry.figure.width <= geometry.width + 1, 'comparison does not widen the page');
  assert(geometry.candidates[0].right <= geometry.candidates[1].left + 1 || geometry.candidates[0].bottom <= geometry.candidates[1].top + 1,
    'candidates remain separate in parallel desktop lanes or stacked mobile lanes');
  assert(geometry.slices[0].bottom <= geometry.slices[1].top && geometry.slices[1].bottom <= geometry.slices[2].top, 'the three questions define complete, ordered visual slices');
  if (!geometry.compact) {
    for (const panels of [geometry.answers, geometry.candidates]) assert(Math.abs(panels[0].top - panels[1].top) <= 1
      && Math.abs(panels[0].width - panels[1].width) <= 1, 'desktop panels retain matching column widths and top alignment');
    assert(Math.abs(geometry.answers[0].height - geometry.answers[1].height) <= 1, 'the answer panels retain equal height');
  }
  assert(geometry.candidateEnds.every(panel => Math.abs(panel.bottom - panel.lastPathBottom - panel.inset) <= 1), 'each usefulness panel ends after its own content without stretching to the other candidate');
  for (const path of geometry.paths) {
    assert.equal(path.paragraphs.length, 2, 'each point contains exactly one evidence sentence and one impact');
    const [support, impact] = path.paragraphs;
    assert(support.bottom < impact.top && impact.weight > support.weight, 'the supporting facts and answer lead into a distinct, stronger user-impact line');
    assert(path.paragraphs.every(paragraph => paragraph.scrollWidth <= paragraph.clientWidth + 1 && paragraph.scrollHeight <= paragraph.clientHeight + 1), 'paragraphs never clip or truncate text');
  }
  if (!geometry.compact) assert(geometry.answerFlows.every(flow => flow.answer.bottom < flow.arrow.top && flow.arrow.bottom < flow.usefulness.top
    && Math.abs((flow.answer.left + flow.answer.right) / 2 - (flow.arrow.left + flow.arrow.right) / 2) <= 1
    && Math.abs((flow.usefulness.left + flow.usefulness.right) / 2 - (flow.arrow.left + flow.arrow.right) / 2) <= 1), 'desktop arrows run straight between the matching answer and usefulness panels');
  assert(geometry.highlights.every(item => item.weight >= 600 && item.background === 'rgb(255, 241, 106)' && item.fragments.every(rect =>
    rect.left >= item.parent.left - 1 && rect.right <= item.parent.right + 1 && rect.top >= item.parent.top - 1 && rect.bottom <= item.parent.bottom + 1)), 'controlled emphasis remains readable and inside its original text at every width');
  assert(geometry.timePhrases.every(phrase => phrase.height <= phrase.lineHeight + 1), 'key time ranges and dates remain unbroken');
  const expected = geometry.compact ? [] : example.candidates.map(candidate => [`${candidate.model}:answer`, `${candidate.model}:usefulness`]);
  assert.deepEqual(geometry.arrows.map(arrow => [arrow.source, arrow.target]).sort(), expected.sort(), 'arrows connect each candidate answer only to its own usefulness section');
  assert(geometry.arrows.every(arrow => arrow.shafts.length && arrow.shafts.every(shaft => shaft.width >= 2 && dark(shaft.stroke))), 'connections retain visible dark shafts');
  for (const arrow of geometry.arrows) {
    assert.equal(arrow.heads.length, 1, 'each short answer-to-usefulness arrow has one head');
    assert(arrow.heads.every(dark), 'arrows retain solid dark heads');
    assert.equal(arrow.source, `${arrow.id}:answer`);
    assert.equal(arrow.target, `${arrow.id}:usefulness`);
    assert.equal(arrow.branch, undefined, 'no arrows remain inside the prose cards');
    assert(arrow.height <= 16 && arrow.width <= 16, 'arrows stay short regardless of prose height');
    assert(arrow.shafts.every(shaft => shaft.points.every(point => Math.abs(point.x - shaft.points[0].x) < 0.1)
      && shaft.points[0].y < shaft.points[1].y && shaft.points[1].y < shaft.points[2].y), 'all arrow shafts are straight and vertical');
    for (const text of geometry.texts) assert(Math.min(arrow.right, text.right) - Math.max(arrow.left, text.left) <= 1
      || Math.min(arrow.bottom, text.bottom) - Math.max(arrow.top, text.top) <= 1, 'short arrows never overlap labels or prose');
  }
  const stateColor = state => geometry.states.find(item => item.state === state)?.color;
  assert(geometry.states.every(item => item.text.length > 0), 'assessment and outcome always include readable labels');
  assert(geometry.states.every(item => item.background === 'rgba(0, 0, 0, 0)') && geometry.surfaces.every(background => background === 'rgb(255, 255, 255)'), 'the template stays white with state colour confined to text');
  if (stateColor('strength') && stateColor('problem')) assert.notEqual(stateColor('strength'), stateColor('problem'), 'strengths and problems have distinct semantic colours');
  if (stateColor('win') && stateColor('problem')) assert.notEqual(stateColor('win'), stateColor('problem'), 'a winning candidate can still contain problem branches');
  assert(geometry.verdict.bottom <= geometry.slices[0].top, 'the formal verdict and its reason precede all three slices');
  if (geometry.caveat) assert(geometry.caveat.top >= geometry.figure.bottom - 1, 'a caveat is not inserted into the comparison graph');
  return geometry;
}

let browser, page;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.goto(server.url);
  const send = async name => { const input = page.locator('[contenteditable=true]'); await input.fill(name); await input.press('Enter'); };
  const settled = async name => {
    await page.getByRole('heading', { name: `${name}已完成`, exact: true }).waitFor();
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
  };
  await send(examples[0].title);
  await page.getByRole('heading', { name: `${examples[0].title}已完成`, exact: true }).waitFor();
  assert.equal(await page.locator('[data-analysis-comparison]').count(), 0, 'a receipt waits for the canonical final answer while prose streams');
  streamGate.resolve(); await settled(examples[0].title);
  await page.locator('[data-analysis-comparison]').waitFor();
  for (const [index, example] of examples.entries()) if (index > 0) {
    await send(example.title); await settled(example.title);
    await page.locator('[data-analysis-comparison]').nth(index).waitFor();
  }
  const reportHeading = page.getByRole('heading', { name: `${examples[0].title}已完成`, exact: true });
  const reportBody = reportHeading.locator('..');
  assert.equal(await reportBody.locator('ul > li').count(), 2, 'report bullets retain distinct attributions');
  assert.equal(await reportBody.locator('table tbody tr').count(), 3, 'a side-by-side report remains a real table');
  assert.equal(await reportBody.locator('table strong').count(), 5, 'the table retains explicit status emphasis');
  const processes = page.locator('[data-turn-process]');
  assert(await processes.evaluateAll(nodes => nodes.every(node => node.getAttribute('aria-expanded') === 'false')), 'finished work steps start collapsed');
  assert.equal(await page.locator('[data-analysis-comparison]').count(), examples.length);
  await processes.first().click(); await processes.first().click();
  assert.equal(await page.locator('[data-analysis-comparison]:visible').count(), examples.length, 'closing tool details does not hide the diagrams');
  const layouts = [];
  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 1200 }); await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const [index, example] of examples.entries()) {
      const visual = page.locator('[data-comparison-visual]').nth(index);
      await visual.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      layouts.push({ title: example.title, ...await inspectDiagram(visual, example) });
      const bounds = await visual.boundingBox();
      await page.setViewportSize({ width, height: Math.max(1200, Math.ceil(bounds.height) + 600) });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await visual.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await visual.screenshot({ path: `${shots}/comparison-${index + 1}-${width}.png`, animations: 'disabled' });
      await page.setViewportSize({ width, height: 1200 });
    }
  }
  await send(failedPrompt); await settled(failedPrompt);
  assert.equal(await page.locator('[data-analysis-comparison]').count(), examples.length, 'even a well-formed diagram in a failed tool receipt stays hidden');
  const before = { executions, receipts };
  await page.reload(); await page.locator('[data-analysis-comparison]').nth(examples.length - 1).waitFor();
  assert.equal(await page.locator('[data-analysis-comparison]').count(), examples.length, 'refresh restores one diagram per accepted receipt');
  assert.deepEqual({ executions, receipts }, before, 'refresh performs no model or tool work');
  assert.equal(await page.locator('[data-turn-chart-fallback] [data-analysis-comparison]').count(), 0, 'final responses do not duplicate diagrams at the tail');
  for (const [index, example] of examples.entries()) await inspectDiagram(page.locator('[data-comparison-visual]').nth(index), example);
  assert.deepEqual(errors, []);
  await writeFile(shots + '/result.json', JSON.stringify({ streaming: true, refresh: true, failedHidden: true, executions, receipts, layouts }, null, 2));
  console.log('Independent comparison branches, outcomes, report table, arrows, narrow layouts, streaming, failure and refresh: passed');
} catch (error) {
  if (page) {
    await writeFile(shots + '/failure.json', JSON.stringify({ error: String(error), text: await page.locator('body').innerText(),
      diagrams: await page.locator('[data-comparison-visual]').evaluateAll(nodes => nodes.map(node => node.outerHTML)) }, null, 2));
    await page.screenshot({ path: shots + '/failure.png', fullPage: true });
  }
  throw error;
} finally { streamGate.resolve(); await browser?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
