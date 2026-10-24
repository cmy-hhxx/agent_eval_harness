import test from "node:test";
import assert from "node:assert/strict";
import { createEris } from "@eval/assistant";
import type { WebSearchRequest, WebReadResult } from "@eval/contracts";

test("statistics preserve the full data and leave conclusions to the continuing model", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
  const metric = { p50: null };
  const row = { id: "a_expert", name: "A Expert", evaluated: 10, wins: 6, losses: 3, both_good: 1, both_bad: 0, winRate: 60,
    accuracy: { correct: 1, count: 2, rate: 50 }, first: { p50: 710 }, total: metric };
  const history = { status: "published", snapshotAt: "2026-10-12 12:16:54.950", requestDates: ["2026-10-11"],
    caseCount: 10, totalCaseCount: 20, stats: [row, { ...row, id: "b_expert", name: "B Expert", wins: 3, losses: 6, winRate: 30 }],
    progress: { completedCaseCount: 8, completedBattleCount: 10, expectedBattleCount: 20, battleCompletionRate: 50, caseCompletionRate: 40 } };
  let published = true;
  const queries: unknown[] = [];
  const tool = createEris({
    data: { list: async query => { queries.push(query); return { kind: "statistics", history: published ? history : { status: "unavailable", error: "未发布" }, currentRuns: [], additive: false }; }, read: unexpected, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } }).tools.find(tool => tool.name === "list_data")!;
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "statistics", signal: new AbortController().signal, progress() {}, complete: unexpected };
  const result = await tool.execute({ view: "statistics" }, context);
  assert.equal(result.terminate, undefined);
  const receipt = JSON.parse(result.content[0].text!);
  assert.deepEqual(receipt, { kind: "statistics", history, currentRuns: [], additive: false },
    "the model receives full statistics without a predetermined conclusion or table");
  assert.deepEqual(queries, [{ view: "statistics" }]);
  published = false;
  assert.equal((await tool.execute({ view: "statistics" }, context)).terminate, undefined, "missing history must leave room to explain the gap");
});

test("batch evidence uses one source read and preserves partial errors, pages and replay coordinates", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
  const calls: unknown[] = [], reference = { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "input" };
  const messages = [{ messageIndex: 3, limit: 2000 }, { messageIndex: 7, offset: 20 }, { messageIndex: 99 }];
  const material = { kind: "evidence", reference, requestedCount: 3, readCount: 2, items: [
    { kind: "message", reference: { ...reference, messageIndex: 3 }, text: "真实证据", evidence: [{ evidence_id: "coordinate", quote: "真实证据" }], hasMore: true, nextOffset: 2000 },
    { kind: "message", reference: { ...reference, messageIndex: 7 }, text: "另一段证据", evidence: [{ evidence_id: "coordinate-7", quote: "另一段证据" }], hasMore: false, nextOffset: null },
    { reference: { ...reference, messageIndex: 99 }, error: "Message index out of range" },
  ] };
  const eris = createEris({
    data: { list: unexpected, read: async (ref, options) => { calls.push({ ref, options }); return material; }, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  const tool = eris.tools.find(tool => tool.name === "read_evidence");
  assert(tool, "deep investigations need one bounded batch instead of repeated per-node calls");
  const args = { reference, messages }, context = { scope: { userId: "test", sessionId: "test" }, callId: "batch", signal: new AbortController().signal, progress() {} };
  const result = await tool.execute(args, context);
  assert.deepEqual(calls, [{ ref: reference, options: { view: "evidence", messages } }]);
  const projected = JSON.parse(result.content[0].text!);
  const nextRead = { tool: "read_evidence", args: { reference: material.items[0].reference, offset: 2000 } };
  assert.deepEqual(projected, { ...material, items: material.items.map(({ evidence: _evidence, ...item }, index) => ({ ...item, ...(index === 0 ? { nextRead } : {}) })) });
  assert.equal(result.content[0].text!.split("真实证据").length - 1, 1, "model context must contain each quoted source once");
  assert.deepEqual(JSON.parse((await tool.execute(args, { ...context, audience: "user" })).content[0].text!),
    { ...material, items: material.items.map((item, index) => ({ ...item, ...(index === 0 ? { nextRead } : {}) })) },
    "the inspector still receives exact source text, quotes and pagination");
  assert.equal(Boolean(result.isError), false, "partial failure keeps successful evidence available");
  assert.deepEqual(result.details, { sourceRead: { tool: "read_evidence", args } });
  assert.equal(tool.readOnly, true);
  await tool.execute({ reference, messages: [{ messageIndex: 3, format: "json", offset: 20 }] }, context);
  assert.deepEqual(calls.at(-1), { ref: reference, options: { view: "evidence", messages: [{ messageIndex: 3, format: "json", offset: 20 }] } });
  const single = { reference: { ...reference, messageIndex: 0 }, format: "json", limit: 100 };
  const original = structuredClone(single);
  const node = await tool.execute(single, context);
  assert.deepEqual(calls.at(-1), { ref: reference, options: { view: "evidence", messages: [{ messageIndex: 0, format: "json", limit: 100 }] } });
  assert.deepEqual(single, original, "defaults do not rewrite the recorded model arguments");
  assert.deepEqual(node.details, { sourceRead: { tool: "read_evidence", args: { reference, messages: [{ messageIndex: 0, format: "json", limit: 100 }] } } });
  await tool.execute({ reference, format: "json", offset: 10, limit: 100, messages: [{ messageIndex: 0 }, { messageIndex: 1, format: "text", offset: 0, limit: 50 }] }, context);
  assert.deepEqual(calls.at(-1), { ref: reference, options: { view: "evidence", messages: [
    { messageIndex: 0, format: "json", offset: 10, limit: 100 }, { messageIndex: 1, format: "text", offset: 0, limit: 50 },
  ] } });
  assert.throws(() => tool.validate!({ reference }), /messages/);
  assert.throws(() => tool.validate!({ ...single, messages: [{ messageIndex: 1 }] }));
  for (const invalid of [[], Array.from({ length: 13 }, (_, messageIndex) => ({ messageIndex })), [{ messageIndex: -1 }], [{ messageIndex: 0, limit: 16001 }], [{ messageIndex: 0, format: "raw" }]])
    assert.throws(() => tool.validate!({ reference, messages: invalid }));
  assert.throws(() => tool.validate!({ reference: { ...reference, taskId: "pair" }, messages }));
  material.requestedCount = 1;
  material.readCount = 0;
  material.items = [material.items[2]];
  assert.equal((await tool.execute({ reference, messages: [{ messageIndex: 99 }] }, context)).isError, true);
});

test("one case read delivers question, answers and trace maps without loading evidence bodies", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
  const calls: unknown[] = [];
  const reference = { collectionId: "0_wencai/0_daily_eval", runId: "run", taskId: "pair" };
  const material = { kind: "case", reference, question: "比较两份回答", answers: [
    { model: "a", reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "answer-a" }, answer: { text: "完整回答", complete: true }, trace: { nodes: [{ messageIndex: 3, type: "tool_result", name: "search", callMessageIndex: 2, reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "answer-a", messageIndex: 3 } }] } },
  ], formal: { comparisonScope: { comparisons: [{ result: "win", winnerModel: "a", reason: "不可当作事实的原评测理由" }] }, result: { verdicts: { result: "both_good" }, evidence: [
    { evidence_id: "ev_11111111-1111-4111-8111-111111111111_3_text_0_10_/output", quote: "按需读取的证据正文" },
    { evidence_id: "ev_11111111-1111-4111-8111-111111111111_3_text_20_30_/output", quote: "同一节点的另一段" },
    { evidence_id: "ev_22222222-2222-4222-8222-222222222222_3_image", quote: "另一回答的图像观察" },
  ] } } };
  const eris = createEris({
    data: { list: unexpected, read: async (ref, options) => { calls.push({ ref, options }); return material; }, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  const tool = eris.tools.find(tool => tool.name === "read_case");
  assert(tool, "case analysis needs a direct entry instead of browsing both message directories");
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "case", signal: new AbortController().signal, progress() {} };
  const result = await tool.execute({ reference }, context);
  const body = JSON.parse(result.content[0].text!);
  assert.deepEqual(calls, [{ ref: reference, options: { view: "case" } }]);
  assert.equal(body.question, material.question);
  assert.deepEqual(body.answers, material.answers.map(answer => ({ ...answer, trace: { ...answer.trace,
    nodes: answer.trace.nodes.map(({ reference: _reference, ...node }) => node) } })));
  assert.deepEqual({ ...body.answers[0].reference, messageIndex: body.answers[0].trace.nodes[0].messageIndex }, material.answers[0].trace.nodes[0].reference,
    "a compact map still resolves the exact source coordinate and call association");
  assert.equal(body.formal.result.evidence, undefined);
  assert.deepEqual(body.formal.result.evidence_references, [
    { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "11111111-1111-4111-8111-111111111111", messageIndex: 3 },
    { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "22222222-2222-4222-8222-222222222222", messageIndex: 3 },
  ], "evidence stays attached to its finding and source; fragments of one node need only one direct read");
  assert.doesNotMatch(JSON.stringify(body), /按需读取的证据正文|同一节点的另一段|另一回答的图像观察/);
  assert.deepEqual(result.details, { sourceRead: { tool: "read_case", args: { reference } } });
  assert.equal(tool.readOnly, true);
  assert.throws(() => tool.validate!({ reference: { ...reference, messageIndex: 3 } }));
  assert.throws(() => tool.validate!({ reference: { ...reference, inputId: "a" } }));
  assert(material.formal.result.evidence, "projection preserves the accepted row");
  const reviewed = await tool.execute({ reference, review: true }, context);
  const reviewedBody = JSON.parse(reviewed.content[0].text!);
  assert.equal(reviewedBody.formal, undefined, "a source review is not an incomplete formal receipt requiring the model to fetch the old judgment");
  assert.deepEqual(reviewedBody.originalVerdicts, [{ result: "win", winnerModel: "a" }],
    "a request to audit the previous winner needs its identity, without rereading the old opinions");
  assert.doesNotMatch(JSON.stringify(reviewedBody), /不可当作事实的原评测理由/);
  assert.equal(reviewedBody.evidence_references, undefined,
    "a source review must not present the old evaluator's selected nodes as an exhaustive evidence shortlist");
  assert.deepEqual(reviewedBody.answers, body.answers.map(({ trace: _trace, ...answer }: Record<string, unknown>) => answer),
    "fact reviews start from full answers and search by entity, rather than bulk reading all raw nodes");
  assert.deepEqual(reviewed.details, { sourceRead: { tool: "read_case", args: { reference, review: true } } });
  assert(material.formal.result.evidence, "review never modifies stored evaluation data");
  const reviewedUI = await tool.execute({ reference, review: true }, { ...context, audience: "user" });
  assert.deepEqual(JSON.parse(reviewedUI.content[0].text!).answers, material.answers, "the expandable scene keeps every node and copyable coordinate");
  assert.deepEqual(JSON.parse(reviewedUI.content[0].text!).formal.result, body.formal.result,
    "the original evaluation remains available to the inspector");
  const userResult = await tool.execute({ reference }, { ...context, audience: "user" });
  assert.deepEqual(JSON.parse(userResult.content[0].text!).answers, material.answers);
  assert.deepEqual(calls.at(-1), { ref: reference, options: { view: "case", audience: "user" } }, "expanded UI gets recorded reasoning and longer previews without increasing model input");
  assert.throws(() => tool.validate!({ reference, audience: "user" }), "display audience is not a model tool argument");
  const lookup = { collectionId: "0_wencai/0_daily_eval", runId: "run", query: "比较两份回答", comparisonTier: "Fast" };
  const located = await tool.execute({ reference: lookup }, context);
  assert.deepEqual(calls.at(-1), { ref: lookup, options: { view: "case" } });
  assert.deepEqual(located.details, { sourceRead: { tool: "read_case", args: { reference } } }, "replay pins the resolved source instead of re-running a potentially ambiguous query");
  await tool.execute({ reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", query: "比较两份回答" } }, context);
  assert.deepEqual(calls.at(-1), { ref: { collectionId: "0_wencai/0_daily_eval", runId: "run", query: "比较两份回答" }, options: { view: "case" } });
  for (const invalid of [{ ...lookup, taskId: "pair" }, { query: "问题" }, { ...lookup, query: " " }])
    assert.throws(() => tool.validate!({ reference: invalid }));
});

test('every directory page keeps exact counts without repeating whole-run narratives or source lists', async () => {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected call'); };
  const reference = { collectionId: "0_wencai/0_daily_eval", runId: 'run', taskId: 'case' };
  const summary = { inputCount: 12, evaluatedInputCount: 10, formalComparisonReferences: [reference], comparisonReviewReferences: [reference],
    formalComparisonStats: { comparisonCount: 3, records: [{ reference, question: 'Only needed for case analysis' }],
      tiers: [{ comparisonTier: 'Fast', comparisonCount: 3, both_good: 1, both_bad: 1, references: [reference], models: [{ wins: 1, losses: 0, both_good: 1, both_bad: 1 }] }] } };
  const original = structuredClone(summary);
  const eris = createEris({ data: { list: async query => query.runId ? { kind: 'inputs', summary } : { kind: 'runs', currentRun: { runId: 'run', summary } }, read: unexpected, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  const tool = eris.tools.find(t => t.name === 'list_data')!;
  const context = { scope: { userId: 'test', sessionId: 'test' }, callId: 'list', signal: new AbortController().signal, progress() {} };
  const result = JSON.parse((await tool.execute({}, context)).content[0].text!);
  assert.equal(result.currentRun.summary.evaluatedInputCount, 10);
  assert.equal(result.currentRun.summary.inputCount, 12);
  assert.equal(result.currentRun.summary.formalComparisonStats.records, undefined);
  assert.equal(result.currentRun.summary.formalComparisonStats.tiers[0].references, undefined);
  assert.deepEqual(result.currentRun.summary.formalComparisonStats.tiers[0].models, summary.formalComparisonStats.tiers[0].models);
  for (const query of [{ collectionId: "0_wencai/0_daily_eval", runId: 'run' }, { collectionId: "0_wencai/0_daily_eval", runId: 'run', query: 'no-match', limit: 1 }, { collectionId: "0_wencai/0_daily_eval", runId: 'run', offset: 100 }]) {
    const page = JSON.parse((await tool.execute(query, context)).content[0].text!);
    assert.deepEqual(page.summary, result.currentRun.summary);
    assert.equal(page.summary.formalComparisonReferences, undefined);
    assert.equal(page.summary.comparisonReviewReferences, undefined);
  }
  assert.deepEqual(summary, original, 'source values and full provenance remain intact for chart validation');
});

test("comparison summaries expose the accepted scope once while details retain every finding", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
  const reference = { collectionId: "0_wencai/0_daily_eval", runId: "run", taskId: "pair" };
  const evidence = { evidence_id: "ev_11111111-1111-4111-8111-111111111111_3_text_0_10_/output", quote: "完整证据" };
  const data = { kind: "accepted-result", reference, evaluatorVersion: "fixture", comparisonScope: {
    comparisons: [{ result: "win", winnerModel: "a" }], assessments: [{ model: "a", summary: "已接受的结论", problemDimensions: [] }], tradeoff: "原评测理由",
  }, result: { status: "decided", ground_truth: { available: false, value: null },
    evaluations: { a: { summary: "重复的底层评语", evidence: [evidence] } }, rewritten: { rewrites: [{ text: "重复的润色评语" }] } } };
  const original = structuredClone(data);
  const tool = createEris({
    data: { list: unexpected, read: async () => data, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } }).tools.find(t => t.name === "read_data")!;
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "summary", signal: new AbortController().signal, progress() {} };
  const summary = JSON.parse((await tool.execute({ reference }, context)).content[0].text!);
  assert.deepEqual(summary.comparisonScope, data.comparisonScope);
  assert.deepEqual(summary.result, { status: "decided", ground_truth: data.result.ground_truth,
    evidence_references: [{ collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "11111111-1111-4111-8111-111111111111", messageIndex: 3 }] });
  assert.doesNotMatch(JSON.stringify(summary), /重复的|完整证据/);
  const details = JSON.parse((await tool.execute({ reference, view: "details", limit: 16000 }, context)).content[0].text!);
  assert.deepEqual(JSON.parse(details.text), original);
  assert.deepEqual(data, original);
});

test("Eris model-facing tool schemas contain no regex lookaround", () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const eris = createEris({ data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  const inspect = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const location = `${path}.${key}`;
      if (key === "pattern" && typeof child === "string")
        assert.doesNotMatch(child, /\(\?(?:[=!]|<[=!])/, `Invalid JSON schema: regex lookaround is not supported. Found at ${location}.`);
      inspect(child, location);
    }
  };
  for (const tool of eris.tools) inspect(tool.inputSchema, tool.name);
});

test("raw arguments fail with field paths and allowed values before SDK coercion or I/O", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const eris = createEris({ data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  const list = eris.tools.find(tool => tool.name === "list_data")!;
  for (const runId of [".", "..", "../run", "a..b", "a..", "a.b..c", "/tmp/run", "a/b", "a\\b", "_run", "-run", "a b", "运行"])
    assert.throws(() => list.validate!({ collectionId: "0_wencai/0_daily_eval", runId }), /\/runId.*schema_pattern/);
  assert.throws(() => list.validate!({ collectionId: "0_wencai/0_daily_eval", runId: "" }), /\/runId.*schema_minLength/);
  assert.throws(() => list.validate!({ collectionId: "0_wencai/0_daily_eval", runId: "a".repeat(182) }), /\/runId.*schema_/);
  for (const runId of ["a", "run", "eval-20261008-134119", "a.b_c-1", "a.", "a.b.", "a.-_b", "a".repeat(181)]) list.validate!({ collectionId: "0_wencai/0_daily_eval", runId });
  for (const args of [{ limit: "5" }, { collectionId: "0_wencai/0_daily_eval", runId: null }, { reference: {} }]) {
    const original = structuredClone(args);
    assert.throws(() => list.validate!(args), /参数无效.*未执行/);
    assert.deepEqual(args, original, "validation never coerces types, drops nulls or strips extra fields");
  }
  assert.throws(() => list.validate!({ view: "comparisons", limit: 21 }), (error: Error) => {
    assert.match(error.message, /\/limit.*schema_maximum.*20/);
    assert.doesNotMatch(error.message, /schema_if|failingKeyword|then.*schema/);
    return true;
  });
  const search = eris.tools.find(tool => tool.name === "search_web")!;
  assert.throws(() => search.validate!({ queries: [{ query: "report" }], category: "finance" }), /\/category.*allowedValues.*web.*news/);
  const read = eris.tools.find(tool => tool.name === "read_data")!;
  assert.throws(() => read.validate!({ reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "input", offset: 0 } }), /\/reference\/offset.*schema_additionalProperties/);
  const chart = eris.tools.find(tool => tool.name === "show_comparison")!;
  const oversized = { reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", taskId: "pair" }, title: "对战", reason: "差异", candidates: ["a", "b"].map(model => ({
    model, summary: "回答", paths: [{ title: "依据", evidence: "字".repeat(399) + "😀😀", impact: "影响", assessment: "problem" }],
  })) };
  assert.throws(() => chart.validate!(oversized), /schema_maxLength.*"actualLength":401.*"excess":1/,
    "length errors must count Unicode characters and say how far over the limit, without silently truncating evidence");
});

test("cancellation blocks all new tool work", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const control = new AbortController();
  const eris = createEris({ data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "cancel", signal: control.signal, progress() {} };
  control.abort();
  for (const tool of eris.tools) await assert.rejects(tool.execute({}, context), { name: "AbortError" });
});

test("external search validates financial filters and forwards cancellation without source rehydration", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const calls: { request: WebSearchRequest; signal: AbortSignal }[] = [];
  const result = {
    provider: "serper" as const, category: "web" as const, searchedAt: "2026-10-02T00:00:00.000Z", elapsedMs: 100,
    attempts: [], results: [{ title: "利率公告", url: "https://www.pbc.gov.cn/", domain: "www.pbc.gov.cn", snippet: "公告原文入口。", rank: 1, matches: [{ queryIndex: 0, position: 1, page: 1 }], dateAssessment: { status: "not_requested" as const, basis: "none" as const } }],
    excludedResults: [], totalUnique: 1, hasMore: false, credits: 1, creditsComplete: true,
  };
  const eris = createEris({
    data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected },
    search: { async search(request, signal) { calls.push({ request, signal }); return result; } }, web: { read: unexpected },
  });
  const tool = eris.tools.find(tool => tool.name === "search_web")!;
  const context = { scope: { userId: "alice", sessionId: "session" }, callId: "search", signal: new AbortController().signal, progress() {} };
  const query = { query: "人民银行 利率公告", domains: ["pbc.gov.cn"] };
  for (const value of [
    { queries: [] }, { queries: [{ query: " " }] }, { queries: [query], limit: 21 }, { queries: [query], category: "finance" },
    { queries: [{ query: "利率", domains: ["https://pbc.gov.cn"] }] }, { queries: [{ query: "利率", domains: ["localhost"] }] },
    { queries: [{ query: "利率", domains: ["pbc.gov.cn", "pbc.gov.cn"] }] }, { queries: [query], timeRange: "all" },
    { queries: [{ query: "利率", country: "China" }] }, { queries: [{ query: "利率", language: "Chinese" }] },
    { queries: [query], dateTo: "2024-07-31", timeRange: "month" }, { queries: [query], dateTo: "yesterday" },
    { queries: [{ ...query, page: 4 }] }, { queries: [query], apiKey: "must-not-come-from-the-model" },
    { queries: [query], country: "China" }, { queries: [query], domains: ["https://pbc.gov.cn"] }, { queries: [query], language: null },
  ]) await assert.rejects(tool.execute(value, context));
  assert.deepEqual(calls, []);
  const request = { queries: [query], category: "web" as const, dateTo: "2024-07-31", limit: 3 };
  const response = await tool.execute(request, context);
  assert.equal(tool.readOnly, true);
  assert.deepEqual(calls, [{ request, signal: context.signal }]);
  assert.deepEqual(response.content, [{ type: "text", text: JSON.stringify(result) }]);
  assert.equal(response.details, undefined, "search results are durable once; inspection and recovery must not issue a fresh paid search");
  const shared = { queries: [{ query: "利率" }, { query: "interest rate", country: "us", language: "en" }], domains: ["pbc.gov.cn"], country: "cn", language: "zh-cn" };
  await tool.execute(shared, context);
  assert.deepEqual(calls.at(-1), { request: shared, signal: context.signal });
});

 test("web reading validates coordinates and stores extracted evidence without a live source reader", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const result: WebReadResult = { url: "https://www.apple.com/report.pdf", requestedUrl: "https://www.apple.com/report.pdf", title: "Annual report", format: "pdf", retrievedAt: "2026-10-02T00:00:00.000Z", elapsedMs: 10, dateAssessment: { status: "unknown", basis: "none" }, lines: [{ number: 12, page: 2, text: "Total net sales 391,035" }], matches: [{ line: 12, page: 2 }], totalLines: 100, totalPages: 3, readPages: 3, nextStartLine: 13, truncated: false, limitations: ["pdf_layout_flattened"] };
  const received: unknown[] = [];
  const eris = createEris({ data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { async read(args, signal) { received.push({ args, signal }); return result; } } });
  const tool = eris.tools.find(tool => tool.name === "read_web")!;
  const context = { scope: { userId: "alice", sessionId: "session" }, callId: "read", signal: new AbortController().signal, progress() {} };
  for (const args of [{ url: "file:///tmp/report" }, { url: result.url, startLine: 0 }, { url: result.url, lineCount: 201 }, { url: result.url, find: " " }, { url: result.url, apiKey: "secret" }]) await assert.rejects(tool.execute(args, context));
  const args = { url: result.url, find: "Total net sales", dateTo: "2024-10-31" };
  const response = await tool.execute(args, context);
  assert(tool.readOnly);
  assert.deepEqual(received, [{ args, signal: context.signal }]);
  assert.deepEqual(response.content, [{ type: "text", text: JSON.stringify(result) }]);
  assert.equal(response.details, undefined, "restoring or inspecting web evidence must not refetch it");
});
