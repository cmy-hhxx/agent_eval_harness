import test from "node:test";
import assert from "node:assert/strict";
import { erisComparisonCheck } from "@eval/prompts";
import type { AssistantSource, JsonObject } from "@eval/contracts";
import { erisTools, type ErisDependencies } from "../src/core/tools.js";

const reference = { runId: "run", taskId: "formal-comparison" };
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
const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
function comparisonTool(read: ErisDependencies["data"]["read"] = async () => accepted()) {
  const tool = erisTools({ code: { execute: unexpected, read: unexpected }, data: { list: unexpected, read, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected } }, {}).find(tool => tool.name === "show_comparison");
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

test("comparison completion is an explicit decision, never an omitted extra model request", async () => {
  const tool = comparisonTool();
  const { complete: _, ...missing } = args;
  await assert.rejects(tool.execute(missing, context), /complete/);
  assert.equal((await tool.execute(args, context)).terminate, true);
  assert.equal((await tool.execute({ ...args, complete: false }, context)).terminate, undefined,
    "a genuine follow-up still continues");
});

test("comparison counterevidence is visible alongside its claim and cannot be silently omitted", async () => {
  const tool = comparisonTool();
  const first = { ...args.candidates[0], paths: [{ ...args.candidates[0]!.paths[0], counterEvidence: "原文另有相关能力，目标用途尚未确认。" }] };
  const result = JSON.parse((await tool.execute({ ...args, candidates: [first, args.candidates[1]] }, context)).content[0].text!);
  assert.equal(result.diagram.candidates[0].paths[0].evidence, first.paths[0].evidence + "；" + first.paths[0].counterEvidence);
  assert.equal(Object.hasOwn(result.diagram.candidates[0].paths[0], "counterEvidence"), false);
  const { counterEvidence: _, ...missing } = first.paths[0];
  await assert.rejects(tool.execute({ ...args, candidates: [{ ...first, paths: [missing] }, args.candidates[1]] }, context), /counterEvidence/);
  for (const counterEvidence of ["", " ", "字".repeat(81)])
    await assert.rejects(tool.execute({ ...args, candidates: [{ ...first, paths: [{ ...first.paths[0], counterEvidence }] }, args.candidates[1]] }, context), /counterEvidence/);
});

test("contradictory conclusions cannot publish or terminate before correction", async () => {
  const tool = comparisonTool();
  const issue = { path: "/candidates/0/paths/0", reason: "已证实相关能力、用途未核验，不能写为只有配套。" };
  const before = structuredClone(args);
  const result = await tool.execute(args, { ...context, async complete(request) {
    assert.deepEqual(JSON.parse(request.text), args, "all titles, impacts, facts and counterfacts are checked together");
    assert.equal(request.systemPrompt, erisComparisonCheck);
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
  const input = { runId: reference.runId, inputId: "answer-a" };
  const evidence = source("read_evidence", { reference: input, items: [{ text: "未被原评语引用的反证" }] });
  const current = source("read_case", { reference, answers: [{ reference: input }], question: "本题" });
  const formal = source("read_data", { reference, comparisonScope: { tradeoff: "本题结论" } });
  const unrelated = source("read_data", { reference: { runId: "run", taskId: "another-case" }, text: "另一题的长评语" });
  const otherRun = source("search_data", { reference: { ...input, runId: "other-run" }, text: "另一运行" });
  await comparisonTool().execute(args, { ...context, async complete(request) {
    assert.deepEqual(request.selectSources!([unrelated, evidence, otherRun, current, formal]), [evidence, current, formal]);
    return checked;
  } });
});

test("comparison question lookup persists the resolved receipt for evidence and scene replay", async () => {
  const lookup = { runId: "run", query: "列出计算过程", comparisonTier: "Expert" };
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

test("comparison highlights accept zero or two total marks and reject a third after reading formal data", async () => {
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
  for (const invalid of [{ ...two, reasonHighlight: "可验证性" }, threeInPaths])
    await assert.rejects(tool.execute(invalid, context), /最多2处高亮/);
  assert.equal(reads, 4, "the graph-wide budget is checked after formal data is read");
});

test("comparison highlights reject empty, excessive, oversized or unsupported emphasis before reading formal data", async () => {
  let reads = 0;
  const tool = comparisonTool(async () => { reads++; return accepted(); });
  for (const highlights of [{}, { evidence: "计算过程", impact: "无法复算" },
    { evidence: "" }, { impact: " " }, { impact: null }, { evidence: "字".repeat(17) }, { impact: "😀".repeat(17) }])
    await assert.rejects(tool.execute({ ...args, candidates: [{ ...args.candidates[0],
      paths: [{ ...args.candidates[0]!.paths[0], highlights }] }, args.candidates[1]] }, context), /参数无效/);
  for (const reasonHighlight of ["", " ", null, "字".repeat(17), "😀".repeat(17)])
    await assert.rejects(tool.execute({ ...args, reasonHighlight }, context), /参数无效/);
  await assert.rejects(tool.execute({ ...args, candidates: [{ ...args.candidates[0], summaryHighlight: "结论" }, args.candidates[1]] }, context), /参数无效/);
  assert.equal(reads, 0);
});

test("comparison highlights must occur exactly once in their corresponding field", async () => {
  const tool = comparisonTool();
  for (const field of ["evidence", "impact"] as const) {
    for (const [text, highlight] of [["未提供计算过程", "完整过程"], ["过程需要解释过程", "过程"], ["aaaa", "aa"], ["😀😀", "😀"]])
      await assert.rejects(tool.execute({ ...args, candidates: [{ ...args.candidates[0],
        paths: [{ ...args.candidates[0]!.paths[0], [field]: text, highlights: { [field]: highlight } }] }, args.candidates[1]] }, context),
      error => error instanceof Error && error.message.includes(`highlights.${field}`) && error.message.includes("唯一出现"));
  }
  for (const [reason, reasonHighlight] of [[args.reason, "未出现的理由"], ["过程决定过程", "过程"], ["aaaa", "aa"]])
    await assert.rejects(tool.execute({ ...args, reason, reasonHighlight }, context), /reasonHighlight.*唯一出现/);
  await assert.rejects(tool.execute({ ...args, candidates: [{ ...args.candidates[0],
    paths: [{ ...args.candidates[0]!.paths[0], highlights: { evidence: "可直接核对" } }] }, args.candidates[1]] }, context), /highlights.evidence.*唯一出现/);
});

test("fixed comparison text limits reject excess content instead of truncating it", async () => {
  let reads = 0;
  const tool = comparisonTool(async () => { reads++; return accepted(); });
  for (const invalid of [
    { ...args, title: "字".repeat(41) }, { ...args, reason: "字".repeat(161) }, { ...args, caveat: "字".repeat(101) },
    { ...args, title: " " }, { ...args, reason: "" }, { ...args, caveat: " " },
    { ...args, candidates: [{ ...args.candidates[0], summary: "字".repeat(81) }, args.candidates[1]] },
    ...[[], Array(4).fill(args.candidates[0]!.paths[0])].map(paths => ({ ...args, candidates: [{ ...args.candidates[0], paths }, args.candidates[1]] })),
    ...[{ title: "字".repeat(17) }, { evidence: "字".repeat(61) }, { evidence: "😀".repeat(61) }, { impact: "字".repeat(37) }, { impact: "😀".repeat(37) },
      { evidence: " " }, { impact: "" }, { assessment: "win" }, { nodes: [] }].map(patch => ({ ...args,
      candidates: [{ ...args.candidates[0], paths: [{ ...args.candidates[0]!.paths[0], ...patch }] }, args.candidates[1]] })),
    { ...args, candidates: args.candidates.slice(0, 1) }, { ...args, candidates: [...args.candidates, args.candidates[0]] },
  ]) await assert.rejects(tool.execute(invalid, context), /参数无效/);
  assert.equal(reads, 0);
  const boundary = { ...args, title: "字".repeat(40), reason: "字".repeat(160), caveat: "字".repeat(100),
    candidates: args.candidates.map(candidate => ({ ...candidate, summary: "字".repeat(80), paths: Array.from({ length: 3 }, () => ({
      title: "😀".repeat(16), evidence: "😀".repeat(60), counterEvidence: null, impact: "😀".repeat(36), assessment: "problem",
    })) })) };
  const output = JSON.parse((await tool.execute(boundary, context)).content[0].text!);
  assert.equal(output.diagram.title, boundary.title);
  assert.deepEqual(output.diagram.candidates[0].paths, rendered(boundary.candidates[0]!).paths);
  assert.equal(output.diagram.reason, boundary.reason);
  assert.equal(output.diagram.caveat, boundary.caveat);
});

test("fixed comparisons reject invalid references, missing or undecided results and different candidates", async () => {
  const tool = comparisonTool();
  for (const invalid of [{ runId: "..", taskId: "task" }, { runId: "run" }, { ...reference, inputId: "input" }, { ...reference, messageIndex: 0 }])
    await assert.rejects(tool.execute({ ...args, reference: invalid }, context), /参数无效/);
  await assert.rejects(comparisonTool(async () => { throw new Error("正式结果不存在"); }).execute(args, context), /不存在/);
  for (const source of [{}, { ...accepted(), kind: "message" }, { ...accepted(), result: undefined },
    { kind: "accepted-result", result: { status: "pending_review" } }, accepted([]), accepted([pair("a", "c", "win", "c")]),
    accepted([{ ...pair(), result: "pending_review" }]),
    accepted([{ ...pair(), models: [{ model: "a", modelName: "A", result: "pending_review" }, pair().models[1]!] }]),
  ]) await assert.rejects(comparisonTool(async () => source).execute(args, context), /正式|对局|模型/);
  await assert.rejects(tool.execute({ ...args, candidates: [args.candidates[0], args.candidates[0]] }, context), /不同|模型/);
});
