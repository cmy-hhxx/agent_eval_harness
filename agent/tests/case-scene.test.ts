import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ROOT } from "../../tests/fixtures/services.js";

const { caseScenesFromTools, loadCaseScene, TurnCaseScenes } = await import(pathToFileURL(path.join(ROOT, "agent/src/client/case-scene.js")).href);
const { traceFlowLayout, evidenceFollowupText, TraceFlow } = await import(pathToFileURL(path.join(ROOT, "agent/src/client/case-flow.js")).href);
const { evidenceParts } = await import(pathToFileURL(path.join(ROOT, "agent/src/client/case-evidence.js")).href);
const entry = (callId: string, tool: string, reference: object, isError = false) => ({ root: {
  kind: 'tool-result', callId, isError, meta: { sourceRead: { tool, args: { reference } } },
} });
const caseRead = entry('case', 'read_case', { runId: 'run', taskId: 'pair' });
const evidence = entry('evidence', 'read_evidence', { runId: 'run', inputId: 'answer-A' });
const material = (inputId: string) => ({ kind: 'case', question: '原问', answers: [{ modelName: 'A组Fast', reference: { runId: 'run', inputId } }] });
const response = (value: object) => ({ ok: true, value: { content: [{ type: 'text', text: JSON.stringify(value) }] } });

test('case scenes are visible in the reply tail without any source read; global turns stay empty', () => {
  let reads = 0;
  const render = (data: unknown[], history: unknown[] = []) => renderToStaticMarkup(createElement(TurnCaseScenes, {
    turn: { turn: 2 }, sessionId: 'session', remote: { toolResult() { reads++; } },
    useChat: (select: (value: unknown) => unknown) => select({ nodes: {
      turnDataSource: () => ({ subscribe: () => () => {}, getSnapshot: () => data }), values: () => history,
    } }),
  }));
  assert.match(render([caseRead]), /链路小现场/);
  assert.match(render([evidence], [{ kind: 'tool-call', location: { kind: 'step', turn: { turn: 1 } }, anchorSeq: 5, data: caseRead }]), /链路小现场/);
  assert.equal(reads, 0);
  assert.equal(render([entry('global', 'list_data', { runId: 'run' })]), '');
  assert.equal(render([entry('failed', 'read_case', { runId: 'run' }, true)]), '');
  assert.equal(caseScenesFromTools([caseRead, { ...caseRead }]).length, 1);
});

test('deep follow-ups resolve the exact answer, skip unrelated cases and deduplicate evidence batches', async () => {
  const unrelated = entry('other', 'read_case', { runId: 'run', taskId: 'other-pair' });
  const wrongRun = entry('different-run', 'read_case', { runId: 'elsewhere', taskId: 'pair' });
  const scenes = caseScenesFromTools([evidence, entry('batch-2', 'read_evidence', { runId: 'run', inputId: 'answer-A' })], [caseRead, unrelated, wrongRun]);
  assert.equal(scenes.length, 1);
  const calls: string[] = [];
  const loaded = await loadCaseScene(scenes[0], async (callId: string) => {
    calls.push(callId); return response(material(callId === 'case' ? 'answer-A' : 'answer-other'));
  });
  assert.deepEqual(calls, ['other', 'case']);
  assert.equal(loaded.answers[0].reference.inputId, 'answer-A');
  await assert.rejects(loadCaseScene(scenes[0], async () => response(material('answer-other'))), /未找到该回答/);
  await assert.rejects(loadCaseScene(scenes[0], async () => ({ ok: false, error: { message: '源文件无法读取' } })), /源文件无法读取/);
});

test('trace flow has one ordered rail and only source-confirmed call associations', () => {
  const nodes = [
    { messageIndex: 0, type: 'user_question', chars: 4 },
    { messageIndex: 3, type: 'tool_call', name: '查询', chars: 8 },
    { messageIndex: 4, type: 'tool_result', chars: 8 },
    { messageIndex: 9, type: 'tool_result', callMessageIndex: 3, chars: 8 },
  ];
  const flow = traceFlowLayout(nodes);
  assert.deepEqual(flow.order.map((edge: { from: { node: { messageIndex: number } }; to: { node: { messageIndex: number } } }) => [edge.from.node.messageIndex, edge.to.node.messageIndex]), [[0, 3], [3, 4], [4, 9]]);
  assert.equal(flow.calls.length, 1, 'adjacent tool results without a call coordinate are not paired');
  assert.equal(flow.calls[0].from.node.messageIndex, 3);
  assert.equal(flow.calls[0].to.node.messageIndex, 9);
  for (let i = 1; i < flow.boxes.length; i++) assert(flow.boxes[i].y - flow.boxes[i - 1].y - flow.boxes[i - 1].height >= 16);
  const svg = renderToStaticMarkup(createElement(TraceFlow, { nodes, finalIndex: 10, selected: 3, onSelect() {}, modelName: 'A组Fast' }));
  assert.equal((svg.match(/data-flow-edge="order"/g) ?? []).length, 3);
  assert.equal((svg.match(/data-flow-edge="call"/g) ?? []).length, 1);
  assert.match(svg, /marker-end=/);
});

test('copying for Eris retains exact evidence coordinates and does not copy a truncated preview as evidence', () => {
  const reference = { runId: 'run', inputId: 'answer-A', messageIndex: 13 };
  const text = evidenceFollowupText({ modelName: 'A组Fast', trace: { finalMessageIndex: 22 } }, { type: 'tool_result', name: '查询', messageIndex: 13, reference, preview: 'TRUNCATED_PREVIEW' });
  assert.match(text, /请继续调查/);
  assert.match(text, /A组Fast/);
  assert.deepEqual(JSON.parse(text.slice(text.indexOf('{'))), { reference });
  assert.doesNotMatch(text, /TRUNCATED_PREVIEW/);
});


test('evidence extracts ordered text blocks and retains table cells and source identifiers', () => {
  const table = '|代码|名称|涨幅|\n|---|---|---|\n|886068.TI|AI视频|5.48%|';
  const raw = JSON.stringify([{ type: 'input_text', text: '<referencable-result>\nID: 15\n' }, { type: 'input_text', text: table }, { type: 'input_text', text: '</referencable-result>' }]);
  assert.deepEqual(evidenceParts(raw), [{ kind: 'text', text: 'ID: 15\n\n' + table }]);
});

test('evidence unwraps encoded content and keeps unknown metadata and nontext blocks', () => {
  const raw = JSON.stringify({ output: JSON.stringify({ content: [{ type: 'output_text', text: '第一行\n第二行' }, { type: 'image', source: 'source-ref' }], isError: true }) });
  const parts = evidenceParts(raw);
  assert.deepEqual(parts[0], { kind: 'text', text: '第一行\n第二行' });
  assert.deepEqual(JSON.parse(parts[1].text), { type: 'image', source: 'source-ref' });
  assert.deepEqual(JSON.parse(parts[2].text), { isError: true });
});

test('evidence does not guess escapes or repair incomplete JSON, and keeps structured arguments', () => {
  const plain = String.raw`path C:\new\tools; literal \n; <script>untrusted</script>`;
  assert.deepEqual(evidenceParts(plain), [{ kind: 'text', text: plain }]);
  const partial = '[{"type":"input_text","text":"首行\\n未结束';
  assert.deepEqual(evidenceParts(partial), [{ kind: 'code', text: partial }]);
  const argumentsText = '{"query":"精确筛选","limit":0,"include":false}';
  assert.deepEqual(JSON.parse(evidenceParts(argumentsText)[0].text), JSON.parse(argumentsText));
});
