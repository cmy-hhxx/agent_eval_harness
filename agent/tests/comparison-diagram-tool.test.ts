import test from "node:test";
import assert from "node:assert/strict";
import { erisComparisonCheck } from "@eval/prompts";
import type { AssistantSource, JsonObject } from "@eval/contracts";
import { erisTools, type ErisDependencies } from "../src/core/tools.js";

const reference = { collectionId: "0_wencai/0_daily_eval", runId: "run", taskId: "formal-comparison" };
const checked = { text: '{"issues":[]}', elapsedMs: 5, usage: { input: 30, output: 8 } };
const context = { scope: { userId: "alice", sessionId: "session" }, callId: "comparison", signal: new AbortController().signal, progress() {}, async complete() { return checked; } };
const args = { reference, complete: true, title: "交付差异", candidates: [
  { model: "a", summary: "结论已给出，过程无法核对", paths: [
    { title: "计算过程", evidence: "题目要求列出计算过程，A却只给出结论。", counterEvidence: null, impact: "无法复算", assessment: "problem" },
  ] },
  { model: "b", summary: "计算过程完整，附加数据仍待核实", paths: [
    { title: "计算过程", evidence: "原始数值与算式一致，B完整列出计算过程。", counterEvidence: null, impact: "可直接核对", assessment: "strength" },
    { title: "附加数据", evidence: "B列出的补充指标尚未找到原始披露。", counterEvidence: null, impact: "补充判断仍待核实", assessment: "uncertain" },
  ] },
], reason: "完整计算过程决定可验证性", caveat: "只代表本题" };
const rendered = <T extends { paths: { evidence: string; counterEvidence: string | null }[] }>(candidate: T) => ({ ...candidate, paths: candidate.paths.map(({ counterEvidence, ...path }) => ({ ...path, evidence: counterEvidence === null ? path.evidence : path.evidence + "；" + counterEvidence })) });
const pair = (first = "a", second = "b", result = "win", winner: string | null = "b") => ({
  result, resultLabel: result === "win" ? `${winner!.toUpperCase()}组正式名称胜` : result === "both_good" ? "双方均好" : "双方均差", winnerModel: winner,
  models: [first, second].map(model => ({ model, modelName: model.toUpperCase() + "组正式名称", result: result === "win" ? model === winner ? "win" : "loss" : result })),
});
const accepted = (comparisons = [pair()]): JsonObject => ({ kind: "accepted-result", reference, evaluatorVersion: "fixture-evaluator",
  result: { evaluation_type: "group_model_comparison", status: "decided" }, comparisonScope: { comparisons } });
const caseMaterial = (formal = accepted()) => ({ kind: "case", reference, question: "请列出计算过程", formal,
  answers: ["a", "b", "c"].map(model => ({ model, reference: { collectionId: "0_wencai/0_daily_eval", runId: reference.runId, inputId: `answer-${model}` },
    answer: { text: `${model} 的完整回答`, complete: true } as JsonObject, trace: { nodes: [] } })) });
const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
function comparisonTool(readFormal: ErisDependencies["data"]["read"] = async () => accepted(), readCase?: ErisDependencies["data"]["read"]) {
  const read: ErisDependencies["data"]["read"] = readCase ?? (async (ref, options) => {
    assert.deepEqual(options, { view: "case" }, "the tool loads answers and the formal result in one case read");
    return caseMaterial(await readFormal(ref));
  });
  const tool = erisTools({ data: { list: unexpected, read, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } }, {}).find(tool => tool.name === "show_comparison");
  assert(tool, "show_comparison must be a registered Eris tool");
  return tool;
}

test("fixed comparisons preserve formal template order, identities and verdict when input order changes", async () => {
  const source = accepted([pair("b", "a")]), before = structuredClone(source), reads: unknown[] = [];
  const tool = comparisonTool(async ref => { reads.push(ref); return source; });
  assert.equal(tool.readOnly, true);
  for (const candidates of [args.candidates, [...args.candidates].reverse()]) {
    const output = await tool.execute({ ...args, candidates }, context);
    assert.deepEqual(JSON.parse(output.content[0].text!), { kind: "comparison-diagram", diagram: {
      title: args.title, candidates: [
        { ...rendered(args.candidates[1]!), name: "B组正式名称", outcome: "win" },
        { ...rendered(args.candidates[0]!), name: "A组正式名称", outcome: "loss" },
      ],
      verdict: "B组正式名称胜", reason: args.reason, caveat: args.caveat,
    } });
    assert.deepEqual(output.details, { reference, evaluatorVersion: "fixture-evaluator", consistencyCheck: { ...checked, issues: [] } });
  }
  assert.deepEqual(reads, [reference, reference]);
  assert.deepEqual(source, before, "the tool never rewrites the accepted result");
});

test("fixed comparisons preserve both-good and both-bad decisions without inventing a winner", async () => {
  for (const [result, label] of [["both_good", "双方均好"], ["both_bad", "双方均差"]]) {
    const tool = comparisonTool(async () => accepted([pair("a", "b", result, null)]));
    const { caveat: _, ...input } = args;
    const output = JSON.parse((await tool.execute(input, context)).content[0].text!);
    assert.equal(output.diagram.verdict, label);
    assert.equal(Object.hasOwn(output.diagram, "caveat"), false);
    assert.equal(Object.hasOwn(output.diagram, "winner"), false);
    assert.deepEqual(output.diagram.candidates.map((candidate: { outcome: string }) => candidate.outcome), [result, result]);
  }
});

test("comparison completion requires explicit true while an omitted flag preserves follow-up analysis", async () => {
  const tool = comparisonTool();
  const { complete: _, ...missing } = args;
  assert.equal((await tool.execute(missing, context)).terminate, undefined);
  assert.equal((await tool.execute(args, context)).terminate, true);
  assert.equal((await tool.execute({ ...args, complete: false }, context)).terminate, undefined,
    "a genuine follow-up still continues");
});

test("comparison counterevidence is visible when supplied and may be absent without adding undefined prose", async () => {
  const tool = comparisonTool();
  const first = { ...args.candidates[0], paths: [{ ...args.candidates[0]!.paths[0], counterEvidence: "原文另有相关能力，目标用途尚未确认。" }] };
  const result = JSON.parse((await tool.execute({ ...args, candidates: [first, args.candidates[1]] }, context)).content[0].text!);
  assert.equal(result.diagram.candidates[0].paths[0].evidence, first.paths[0].evidence + "；" + first.paths[0].counterEvidence);
  assert.equal(Object.hasOwn(result.diagram.candidates[0].paths[0], "counterEvidence"), false);
  const { counterEvidence: _, ...missing } = first.paths[0];
  const input = { ...args, candidates: [{ ...first, paths: [missing] }, args.candidates[1]] };
  const without = JSON.parse((await tool.execute(input, context)).content[0].text!);
  assert.equal(without.diagram.candidates[0].paths[0].evidence, missing.evidence);
  const blocked = await tool.execute(input, { ...context, async complete() {
    return { ...checked, text: JSON.stringify({ issues: [{ path: "/candidates/0/paths/0", reason: "遗漏已知重要反证" }] }) };
  } });
  assert.equal(blocked.isError, true, "an optional field cannot bypass the known-evidence consistency check");
  assert.equal(blocked.terminate, undefined);
  for (const counterEvidence of ["", " ", "字".repeat(401)])
    await assert.rejects(tool.execute({ ...args, candidates: [{ ...first, paths: [{ ...first.paths[0], counterEvidence }] }, args.candidates[1]] }, context), /counterEvidence/);
});

test("contradictory conclusions cannot publish or terminate before correction", async () => {
  const tool = comparisonTool();
  const issue = { path: "/candidates/0/paths/0", reason: "已证实相关能力、用途未核验，不能写为只有配套。" };
  const before = structuredClone(args);
  const result = await tool.execute(args, { ...context, async complete(request) {
    const { complete: _complete, ...draft } = args;
    assert.deepEqual(request.draft, draft, "all titles, impacts, facts and counterfacts are checked together");
    assert.equal(request.systemPrompt, erisComparisonCheck);
    assert.equal(request.maxThinking, "low", "only the isolated check requests a lower reasoning level");
    return { ...checked, text: JSON.stringify({ issues: [issue] }) };
  } });
  assert.equal(result.isError, true);
  assert.equal(result.terminate, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text!), { kind: "comparison-check", issues: [issue] });
  assert.deepEqual(args, before, "a check does not silently rewrite or remove evidence");
  assert.deepEqual(((result.details as JsonObject).consistencyCheck as JsonObject).usage, checked.usage);
  assert.equal((await tool.execute(args, context)).terminate, true);
  for (const text of ['not JSON', '{}', '{"issues":"ok"}', '{"issues":[],"other":true}'])
    assert.equal((await tool.execute(args, { ...context, async complete() { return { ...checked, text }; } })).isError, true);
  await assert.rejects(tool.execute(args, { ...context, complete: undefined }), /尚未展示/);
  await assert.rejects(tool.execute(args, { ...context, async complete() { throw new Error("Gateway failed"); } }), /Gateway failed/);
});

test("comparison checks retain this pair's earlier evidence and omit unrelated cases", async () => {
  const source = (tool: string, value: unknown): AssistantSource => ({ tool, content: [{ type: "text", text: JSON.stringify(value) }] });
  const input = { collectionId: "0_wencai/0_daily_eval", runId: reference.runId, inputId: "answer-a" };
  const node = { kind: "message", reference: { ...input, messageIndex: 4 }, format: "text", offset: 0,
    text: "未被原评语引用的反证", hasMore: true, nextOffset: 10 };
  const evidence = source("read_evidence", { reference: input, items: [node] });
  const current = source("read_case", { reference, answers: [{ reference: input }], question: "本题" });
  const formal = source("read_data", { reference, comparisonScope: { tradeoff: "本题结论" } });
  const unrelated = source("read_data", { reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", taskId: "another-case" }, text: "另一题的长评语" });
  const otherRun = source("search_data", { reference: { ...input, runId: "other-run" }, text: "另一运行" });
  await comparisonTool().execute(args, { ...context, async complete(request) {
    const selected = request.selectSources!([unrelated, evidence, otherRun, current, formal]);
    assert.deepEqual(selected.slice(1), [source("read_evidence", node), current, formal]);
    assert.deepEqual(JSON.parse(selected[0]!.content[0].text!).answers.map((answer: JsonObject) => answer.model), ["a", "b"]);
    return checked;
  } });
});

test("comparison checks deduplicate exact evidence pages without losing changed text, bounds, formats or uncited counterevidence", async () => {
  const source = (tool: string, material: unknown): AssistantSource => ({ tool, content: [{ type: "text", text: JSON.stringify(material) }] });
  const input = { collectionId: "0_wencai/0_daily_eval", runId: reference.runId, inputId: "answer-a" };
  const page = { kind: "message", reference: { ...input, messageIndex: 4 }, format: "text", offset: 0,
    text: '支持材料\n但存在反证 "边界"', total: 100, hasMore: true, nextOffset: 20 };
  const later = { ...page, offset: 20, text: "后续反证", hasMore: false, nextOffset: null };
  const changed = { ...page, text: "同坐标但内容改变，必须保留" };
  const json = { ...page, format: "json", text: '{"price":0,"valid":false}' };
  const trace = { nodes: [{ messageIndex: 4, type: "tool_result", name: "search", reference: page.reference,
    preview: "尚未完整读取", previewTruncated: true }, { messageIndex: 5, type: "reasoning", chars: 9000 }] };
  const current = { kind: "case", reference, question: "本题", answers: [{ reference: input,
    answer: { text: "完整回答", complete: true }, trace }] };
  const before = structuredClone(current);
  await comparisonTool().execute({ ...args, reasonHighlight: "可验证性", candidates: args.candidates.map(candidate => ({ ...candidate,
    paths: candidate.paths.map(path => ({ ...path, highlights: { evidence: "计算过程" } })) })) }, { ...context, async complete(request) {
    assert.equal(Object.hasOwn(request.draft, "complete"), false);
    assert.equal(Object.hasOwn(request.draft, "reasonHighlight"), false);
    const candidates = request.draft.candidates as { paths: JsonObject[] }[];
    assert(candidates.every(candidate => candidate.paths.every(path => !Object.hasOwn(path, "highlights"))));
    const selected = request.selectSources!([
      source("read_case", current), source("read_case", current),
      source("read_evidence", { reference: input, items: [page, later] }),
      source("read_data", { ...page, limit: 8000, nextRead: { tool: "read_data", args: {} } }),
      source("read_evidence", { reference: input, items: [changed, json, { kind: "message-error", reference: page.reference, error: "来源不可读" }] }),
    ]);
    const materials = selected.map(item => JSON.parse(item.content[0].text!));
    assert.equal(materials.length, 7);
    assert.deepEqual(materials.slice(2, 6), [page, later, changed, json]);
    assert.equal(materials[6].error, "来源不可读");
    assert.deepEqual(materials[1].answers[0].answer, current.answers[0].answer);
    assert.deepEqual(materials[1].answers[0].trace, { nodes: [trace.nodes[0]] });
    assert.deepEqual(current, before, "source packing cannot mutate conversation evidence");
    assert.equal(request.selectSources!([]).length, 1, "case evidence does not depend on surviving conversation messages");
    return checked;
  } });
});

test("comparison checks load this pair without a prior read_case and continue incomplete answer pages", async () => {
  const material = caseMaterial();
  const answerReference = { collectionId: "0_wencai/0_daily_eval", runId: reference.runId, inputId: "answer-a", messageIndex: 3 };
  material.answers[0]!.answer = { reference: answerReference, preview: "截断预览", complete: false };
  const reads: unknown[] = [];
  const tool = comparisonTool(undefined, async (ref, options) => {
    reads.push({ ref, options });
    if (options?.view === "case") return material;
    assert(options && options.view !== "evidence", "long answers use single-message pagination");
    assert.deepEqual(ref, answerReference);
    return { kind: "message", reference: answerReference, format: "text", offset: options.offset,
      text: options.offset === 0 ? "支持证据" : "决定性的反证", hasMore: options.offset === 0, nextOffset: options.offset === 0 ? 4 : null };
  });
  const result = await tool.execute(args, { ...context, async complete(request) {
    const sources = request.selectSources!([]).map(source => JSON.parse(source.content[0].text!));
    assert.equal(sources[0].question, material.question);
    assert.deepEqual(sources[0].formal, accepted());
    assert.deepEqual(sources[0].answers.map((answer: JsonObject) => answer.model), ["a", "b"]);
    assert.deepEqual(sources.slice(1).map(source => source.text), ["支持证据", "决定性的反证"]);
    return { ...checked, text: '{"issues":[{"path":"/reason","reason":"忽略决定性的反证"}]}' };
  } });
  assert.deepEqual(reads, [
    { ref: reference, options: { view: "case" } },
    { ref: answerReference, options: { offset: 0, limit: 16000 } },
    { ref: answerReference, options: { offset: 4, limit: 16000 } },
  ], "one case read and two necessary answer pages use the data contract without a model repair round trip");
  assert.equal(result.isError, true);
  assert.equal(result.terminate, undefined, "automatically loaded counterevidence still blocks a misleading diagram");
});

test("missing original answers block comparison checks instead of accepting an ungrounded draft", async () => {
  const tool = comparisonTool(undefined, async () => ({ ...caseMaterial(), answers: [] }));
  await assert.rejects(tool.execute(args, { ...context, complete: unexpected }), /原始.*回答/);
});

test("incomplete answer pagination cannot silently bypass evidence checking", async () => {
  const material = caseMaterial();
  material.answers[0]!.answer = { reference: { collectionId: "0_wencai/0_daily_eval", runId: reference.runId, inputId: "answer-a", messageIndex: 3 }, complete: false, preview: "只有预览" };
  const tool = comparisonTool(undefined, async (_ref, options) => options?.view === "case" ? material
    : { kind: "message", text: "缺失后续内容", hasMore: true, nextOffset: 0 });
  await assert.rejects(tool.execute(args, { ...context, complete: unexpected }), /分页不完整/);
});

test("comparison question lookup persists the resolved receipt for evidence and scene replay", async () => {
  const lookup = { collectionId: "0_wencai/0_daily_eval", runId: "run", query: "列出计算过程", comparisonTier: "Expert" };
  const tool = comparisonTool(async ref => { assert.deepEqual(ref, lookup); return accepted(); });
  const output = await tool.execute({ ...args, reference: lookup }, context);
  assert.deepEqual(output.details, { reference, evaluatorVersion: "fixture-evaluator", consistencyCheck: { ...checked, issues: [] } });
  assert.equal(JSON.parse(output.content[0].text!).diagram.verdict, "B组正式名称胜");
  await assert.rejects(tool.execute({ ...args, reference: { ...lookup, taskId: "guess" } }, context), /参数无效/);
});

test("fixed comparisons select the exact candidate pair from a multi-pair scope", async () => {
  const tool = comparisonTool(async () => accepted([pair(), pair("a", "c", "win", "c"), pair("b", "c", "both_bad", null)]));
  const candidates = [args.candidates[0]!, { ...args.candidates[1]!, model: "c" }];
  const output = JSON.parse((await tool.execute({ ...args, candidates }, context)).content[0].text!);
  assert.equal(output.diagram.verdict, "C组正式名称胜");
  assert.equal(output.diagram.candidates[1].name, "C组正式名称");
  await assert.rejects(tool.execute({ ...args, candidates: [candidates[0], { ...candidates[1], model: "d" }] }, context), /对局|模型/);
  await assert.rejects(comparisonTool(async () => accepted([pair(), pair()])).execute(args, context), /对局|模型/);
});

test("fixed comparison arguments cannot supply a winner, diagram geometry, styles or model names", async () => {
  let reads = 0;
  const tool = comparisonTool(async () => { reads++; return accepted(); });
  for (const extra of [{ winner: "a" }, { verdict: "A胜" }, { edges: [] }, { style: { color: "red" } }, { x: 1 }, { operationId: "operation" }])
    await assert.rejects(tool.execute({ ...args, ...extra }, context), /参数无效/);
  await assert.rejects(tool.execute({ ...args, candidates: [{ ...args.candidates[0], name: "伪造名称" }, args.candidates[1]] }, context), /参数无效/);
  await assert.rejects(tool.execute({ ...args, candidates: [{ ...args.candidates[0], outcome: "win" }, args.candidates[1]] }, context), /参数无效/);
  for (const highlights of [{ verdict: "A胜" }, { name: "伪造名称" }, { outcome: "win" }])
    await assert.rejects(tool.execute({ ...args, candidates: [{ ...args.candidates[0],
      paths: [{ ...args.candidates[0]!.paths[0], highlights }] }, args.candidates[1]] }, context), /参数无效/);
  assert.equal(reads, 0, "invalid fields are rejected before reading formal data");
});

test("comparison highlights preserve exact Unicode text and remain attached to the formal candidate order", async () => {
  const source = accepted([pair("b", "a")]), before = structuredClone(source), evidenceHighlight = "😀".repeat(16), reasonHighlight = "😀".repeat(16);
  const first = { ...args.candidates[0], paths: [{ ...args.candidates[0]!.paths[0],
    evidence: `核验${evidenceHighlight}完成`, highlights: { evidence: evidenceHighlight } }] };
  const input = { ...args, candidates: [first, args.candidates[1]], reason: `已确认${reasonHighlight}影响判断`, reasonHighlight };
  const output = JSON.parse((await comparisonTool(async () => source).execute(input, context)).content[0].text!);
  assert.deepEqual(output.diagram, {
    title: args.title, candidates: [
      { ...rendered(args.candidates[1]!), name: "B组正式名称", outcome: "win" },
      { ...rendered(first), name: "A组正式名称", outcome: "loss" },
    ], verdict: "B组正式名称胜", reason: input.reason, reasonHighlight, caveat: args.caveat,
  });
  assert.deepEqual(source, before, "emphasis never modifies the accepted decision");
});

test("comparison highlights keep at most two marks without rejecting otherwise valid analysis", async () => {
  let reads = 0;
  const tool = comparisonTool(async () => { reads++; return accepted(); });
  const plain = JSON.parse((await tool.execute(args, context)).content[0].text!);
  assert.equal(Object.hasOwn(plain.diagram, "reasonHighlight"), false);
  assert.equal(Object.hasOwn(plain.diagram.candidates[0].paths[0], "highlights"), false);
  const two = { ...args, candidates: [
    { ...args.candidates[0], paths: [{ ...args.candidates[0]!.paths[0], highlights: { evidence: "计算过程" } }] },
    { ...args.candidates[1], paths: [{ ...args.candidates[1]!.paths[0], highlights: { impact: "可直接核对" } }, args.candidates[1]!.paths[1]] },
  ] };
  const acceptedTwo = JSON.parse((await tool.execute(two, context)).content[0].text!);
  assert.deepEqual(acceptedTwo.diagram.candidates.map((candidate: { paths: { highlights?: unknown }[] }) => candidate.paths[0]!.highlights),
    [{ evidence: "计算过程" }, { impact: "可直接核对" }]);
  const threeInPaths = { ...two, candidates: [two.candidates[0], { ...two.candidates[1], paths: [two.candidates[1]!.paths[0],
    { ...args.candidates[1]!.paths[1], highlights: { evidence: "原始披露" } }] }] };
  const priority = await tool.execute({ ...two, reasonHighlight: "可验证性" }, context);
  const diagram = JSON.parse(priority.content[0].text!).diagram;
  assert.equal(diagram.reasonHighlight, "可验证性");
  assert.deepEqual(diagram.candidates[0].paths[0].highlights, { evidence: "计算过程" });
  assert.equal(diagram.candidates[1].paths[0].highlights, undefined);
  assert.deepEqual((priority.details as JsonObject).omittedHighlights, ["candidates[1].paths[0].highlights.impact"]);
  const overflow = await tool.execute(threeInPaths, context);
  assert.deepEqual((overflow.details as JsonObject).omittedHighlights, ["candidates[1].paths[1].highlights.evidence"]);
  assert.equal(reads, 4);
});

test("comparison highlights reject wrong types and unknown fields before reading formal data", async () => {
  let reads = 0;
  const tool = comparisonTool(async () => { reads++; return accepted(); });
  for (const highlights of [[], { evidence: [] }, { evidence: "字".repeat(601) }])
    await assert.rejects(tool.execute({ ...args, candidates: [{ ...args.candidates[0],
      paths: [{ ...args.candidates[0]!.paths[0], highlights }] }, args.candidates[1]] }, context), /参数无效/);
  for (const reasonHighlight of [[], "字".repeat(601)])
    await assert.rejects(tool.execute({ ...args, reasonHighlight }, context), /参数无效/);
  await assert.rejects(tool.execute({ ...args, candidates: [{ ...args.candidates[0], summaryHighlight: "结论" }, args.candidates[1]] }, context), /参数无效/);
  assert.equal(reads, 0);
});

test("null comparison highlights are optional decorations", async () => {
  for (const highlights of [null, { evidence: null, impact: null }]) {
    const result = await comparisonTool().execute({ ...args, reasonHighlight: null, candidates: [
      { ...args.candidates[0], paths: [{ ...args.candidates[0]!.paths[0], highlights }] }, args.candidates[1],
    ] }, context);
    const diagram = JSON.parse(result.content[0].text!).diagram;
    assert.equal(diagram.reasonHighlight, undefined);
    assert.equal(diagram.candidates[0].paths[0].highlights, undefined);
    assert.equal((result.details as JsonObject).omittedHighlights, undefined);
    assert.equal(result.terminate, true);
  }
});

test("comparison highlights resolve formatting to an exact unique original span without rewriting text", async () => {
  for (const [text, phrase, expected] of [
    ["必须核对计算过程。", "  **计算过程**  ", "计算过程"],
    ["必须核对计算过程。", "`计算过程`", "计算过程"],
    ["已核对A \n B的数据。", "A B", "A \n B"],
    ["已核对Ａ＋Ｂ的数据。", "A+B", "Ａ＋Ｂ"],
    ["已核对😀Ａ的数据。", "😀A", "😀Ａ"],
  ]) {
    const result = await comparisonTool().execute({ ...args, reason: text, reasonHighlight: phrase, candidates: [
      { ...args.candidates[0], paths: [{ ...args.candidates[0]!.paths[0], evidence: text, highlights: { evidence: phrase } }] }, args.candidates[1],
    ] }, context);
    const diagram = JSON.parse(result.content[0].text!).diagram;
    assert.equal(diagram.reason, text);
    assert.equal(diagram.reasonHighlight, expected);
    assert.equal(diagram.candidates[0].paths[0].evidence, text);
    assert.deepEqual(diagram.candidates[0].paths[0].highlights, { evidence: expected });
    assert.equal((result.details as JsonObject).omittedHighlights, undefined);
  }
  for (const [reason, reasonHighlight] of [["A  B与Ａ Ｂ", "A B"], ["ＡＡＡ", "AA"], ["A" + " ".repeat(16) + "B", "A B"]]) {
    const result = await comparisonTool().execute({ ...args, reason, reasonHighlight }, context);
    const diagram = JSON.parse(result.content[0].text!).diagram;
    assert.equal(diagram.reasonHighlight, undefined, "ambiguous or oversized source spans are never guessed");
    assert.equal(diagram.reason, reason);
    assert.equal(result.terminate, true);
  }
});

test("empty, oversized and extra decorations never truncate the comparison text", async () => {
  const tool = comparisonTool();
  for (const phrase of ["", " ", "😀".repeat(17)]) {
    const evidence = `材料${phrase}结束`;
    const result = await tool.execute({ ...args, reason: evidence, reasonHighlight: phrase, candidates: [
      { ...args.candidates[0], paths: [{ ...args.candidates[0]!.paths[0], evidence, highlights: { evidence: phrase } }] }, args.candidates[1],
    ] }, context);
    const diagram = JSON.parse(result.content[0].text!).diagram;
    assert.equal(diagram.reason, evidence);
    assert.equal(diagram.reasonHighlight, undefined);
    assert.equal(diagram.candidates[0].paths[0].evidence, evidence);
    assert.equal(diagram.candidates[0].paths[0].highlights, undefined);
    assert.deepEqual((result.details as JsonObject).omittedHighlights, ["reasonHighlight", "candidates[0].paths[0].highlights.evidence"]);
  }
  for (const highlights of [{}, { evidence: "计算过程", impact: "无法复算" }]) {
    const result = await tool.execute({ ...args, candidates: [{ ...args.candidates[0],
      paths: [{ ...args.candidates[0]!.paths[0], highlights }] }, args.candidates[1]] }, context);
    const path = JSON.parse(result.content[0].text!).diagram.candidates[0].paths[0];
    assert.equal(path.evidence, args.candidates[0]!.paths[0]!.evidence);
    assert.equal(Object.keys(path.highlights ?? {}).length, Object.keys(highlights).length ? 1 : 0);
  }
});

test("unmatched comparison emphasis is omitted with a receipt instead of blocking the diagram", async () => {
  const tool = comparisonTool();
  for (const field of ["evidence", "impact"] as const) {
    for (const [text, highlight] of [["未提供计算过程", "完整过程"], ["过程需要解释过程", "过程"], ["aaaa", "aa"], ["😀😀", "😀"]]) {
      const result = await tool.execute({ ...args, candidates: [{ ...args.candidates[0],
        paths: [{ ...args.candidates[0]!.paths[0], [field]: text, highlights: { [field]: highlight } }] }, args.candidates[1]] }, context);
      const diagram = JSON.parse(result.content[0].text!).diagram;
      assert.equal(diagram.candidates[0].paths[0][field], text);
      assert.equal(diagram.candidates[0].paths[0].highlights, undefined);
      assert.deepEqual((result.details as JsonObject).omittedHighlights, [`candidates[0].paths[0].highlights.${field}`]);
      assert.equal(result.terminate, true);
    }
  }
  for (const [reason, reasonHighlight] of [[args.reason, "未出现的理由"], ["过程决定过程", "过程"], ["aaaa", "aa"],
    ["先核实“今天上涨”是否成立，B先指出前提不成立。", "先核实行情"]]) {
    const result = await tool.execute({ ...args, reason, reasonHighlight }, context);
    const diagram = JSON.parse(result.content[0].text!).diagram;
    assert.equal(diagram.reason, reason);
    assert.equal(diagram.reasonHighlight, undefined);
    assert.deepEqual((result.details as JsonObject).omittedHighlights, ["reasonHighlight"]);
    assert.equal(result.terminate, true);
  }
});

test("fixed comparison text limits reject excess content instead of truncating it", async () => {
  let reads = 0;
  const tool = comparisonTool(async () => { reads++; return accepted(); });
  for (const invalid of [
    { ...args, title: "字".repeat(121) }, { ...args, reason: "字".repeat(601) }, { ...args, caveat: "字".repeat(401) },
    { ...args, title: " " }, { ...args, reason: "" }, { ...args, caveat: " " },
    { ...args, candidates: [{ ...args.candidates[0], summary: "字".repeat(241) }, args.candidates[1]] },
    ...[[], Array(4).fill(args.candidates[0]!.paths[0])].map(paths => ({ ...args, candidates: [{ ...args.candidates[0], paths }, args.candidates[1]] })),
    ...[{ title: "字".repeat(49) }, { evidence: "字".repeat(401) }, { evidence: "😀".repeat(401) }, { impact: "字".repeat(241) }, { impact: "😀".repeat(241) },
      { evidence: " " }, { impact: "" }, { assessment: "win" }, { nodes: [] }].map(patch => ({ ...args,
      candidates: [{ ...args.candidates[0], paths: [{ ...args.candidates[0]!.paths[0], ...patch }] }, args.candidates[1]] })),
    { ...args, candidates: args.candidates.slice(0, 1) }, { ...args, candidates: [...args.candidates, args.candidates[0]] },
  ]) await assert.rejects(tool.execute(invalid, context), /参数无效/);
  assert.equal(reads, 0);
  const boundary = { ...args, title: "字".repeat(120), reason: "字".repeat(600), caveat: "字".repeat(400),
    candidates: args.candidates.map(candidate => ({ ...candidate, summary: "字".repeat(240), paths: Array.from({ length: 3 }, () => ({
      title: "😀".repeat(48), evidence: "😀".repeat(400), counterEvidence: "界".repeat(400), impact: "😀".repeat(240), assessment: "problem",
    })) })) };
  const output = JSON.parse((await tool.execute(boundary, context)).content[0].text!);
  assert.equal(output.diagram.title, boundary.title);
  assert.deepEqual(output.diagram.candidates[0].paths, rendered(boundary.candidates[0]!).paths);
  assert.equal(output.diagram.reason, boundary.reason);
  assert.equal(output.diagram.caveat, boundary.caveat);
});

test("fixed comparisons reject invalid references, missing or undecided results and different candidates", async () => {
  const tool = comparisonTool();
  for (const invalid of [{ collectionId: "0_wencai/0_daily_eval", runId: "..", taskId: "task" }, { collectionId: "0_wencai/0_daily_eval", runId: "run" }, { ...reference, inputId: "input" }, { ...reference, messageIndex: 0 }])
    await assert.rejects(tool.execute({ ...args, reference: invalid }, context), /参数无效/);
  await assert.rejects(comparisonTool(async () => { throw new Error("正式结果不存在"); }).execute(args, context), /不存在/);
  for (const source of [{}, { ...accepted(), kind: "message" }, { ...accepted(), result: undefined },
    { kind: "accepted-result", result: { status: "pending_review" } }, accepted([]), accepted([pair("a", "c", "win", "c")]),
    accepted([{ ...pair(), result: "pending_review" }]),
    accepted([{ ...pair(), models: [{ model: "a", modelName: "A", result: "pending_review" }, pair().models[1]!] }]),
  ]) await assert.rejects(comparisonTool(async () => source).execute(args, context), /正式|对局|模型/);
  await assert.rejects(tool.execute({ ...args, candidates: [args.candidates[0], args.candidates[0]] }, context), /不同|模型/);
});
