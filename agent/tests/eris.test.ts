import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createEris, type ErisDependencies } from "@eval/assistant";
import { erisPrompt } from "@eval/prompts";
import type { WebSearchRequest, WebSearchAttempt, WebReadResult, SpecialistResult } from "@eval/contracts";

test('every directory page keeps exact counts without repeating whole-run narratives or source lists', async () => {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected call'); };
  const reference = { runId: 'run', taskId: 'case' };
  const summary = { inputCount: 12, evaluatedInputCount: 10, formalComparisonReferences: [reference], comparisonReviewReferences: [reference],
    formalComparisonStats: { comparisonCount: 3, records: [{ reference, question: 'Only needed for case analysis' }],
      tiers: [{ comparisonTier: 'Fast', comparisonCount: 3, both_good: 1, both_bad: 1, references: [reference], models: [{ wins: 1, losses: 0, both_good: 1, both_bad: 1 }] }] } };
  const original = structuredClone(summary);
  const eris = createEris({ code: { execute: unexpected, read: unexpected }, data: { list: async query => query.runId ? { kind: 'inputs', summary } : { kind: 'runs', currentRun: { runId: 'run', summary } }, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  const tool = eris.tools.find(t => t.name === 'list_data')!;
  const context = { scope: { userId: 'test', sessionId: 'test' }, callId: 'list', signal: new AbortController().signal, progress() {} };
  const result = JSON.parse((await tool.execute({}, context)).content[0].text!);
  assert.equal(result.currentRun.summary.evaluatedInputCount, 10);
  assert.equal(result.currentRun.summary.inputCount, 12);
  assert.equal(result.currentRun.summary.formalComparisonStats.records, undefined);
  assert.equal(result.currentRun.summary.formalComparisonStats.tiers[0].references, undefined);
  assert.deepEqual(result.currentRun.summary.formalComparisonStats.tiers[0].models, summary.formalComparisonStats.tiers[0].models);
  for (const query of [{ runId: 'run' }, { runId: 'run', query: 'no-match', limit: 1 }, { runId: 'run', offset: 100 }]) {
    const page = JSON.parse((await tool.execute(query, context)).content[0].text!);
    assert.deepEqual(page.summary, result.currentRun.summary);
    assert.equal(page.summary.formalComparisonReferences, undefined);
    assert.equal(page.summary.comparisonReviewReferences, undefined);
  }
  assert.deepEqual(summary, original, 'source values and full provenance remain intact for chart validation');
});

test("Eris's public definition includes every tool resource and validates before invoking dependencies", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const received: unknown[] = [];
  const dependencies: ErisDependencies = { code: { execute: unexpected, read: unexpected },
    data: { list: async (query) => { received.push(query); return { items: [] }; }, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected },
  };
  const eris = createEris(dependencies);
  const resources = new URL("../../packages/prompts/resources/eris/", import.meta.url);
  assert.equal(eris.systemPrompt, readFileSync(new URL("system.md", resources), "utf8").trim());
  assert.equal(eris.recoveryMessage, readFileSync(new URL("recovery.md", resources), "utf8").trim());
  assert.deepEqual(eris.tools.map((tool) => `${tool.name}.md`).sort(), readdirSync(new URL("tools/", resources)).sort());
  for (const tool of eris.tools) assert.equal(tool.description, readFileSync(new URL(`tools/${tool.name}.md`, resources), "utf8").trim());
  const list = eris.tools.find((tool) => tool.name === "list_data")!;
  assert.match(JSON.stringify(list.inputSchema), /字面文本筛选词.*不是数据类别/);
  const context = { scope: { userId: "alice", sessionId: "session" }, callId: "list", signal: new AbortController().signal, progress() {} };
  await assert.rejects(list.execute({ limit: 0 }, context));
  await assert.rejects(list.execute({ runId: "run", query: "" }, context));
  await assert.rejects(list.execute({ view: "comparisons" }, context), /runId/);
  await assert.rejects(list.execute({ runId: "run", view: "comparisons", limit: 21 }, context), /20/);
  assert.deepEqual(received, []);
  const listed = await list.execute({ limit: 5 }, context);
  assert.equal(listed.details, undefined, "business JSON is stored only once");
  await list.execute({ runId: "run" }, context);
  await list.execute({ runId: "run", query: "A组Fast" }, context);
  await list.execute({ runId: "run", view: "comparisons", limit: 1 }, context);
  const read = eris.tools.find(tool => tool.name === "read_data")!;
  assert.match(JSON.stringify(read.inputSchema), /顶层字段，与 reference 同级/);
  const searchTool = eris.tools.find(tool => tool.name === "search_web")!;
  assert.match(JSON.stringify(searchTool.inputSchema), /只有 web（默认）和 news 两个合法值，没有 finance/);
  const chartTool = eris.tools.find(tool => tool.name === "show_chart")!;
  assert(!(chartTool.inputSchema as { required: string[] }).required.includes("references"), "external material charts omit local provenance references");
  await assert.rejects(read.execute({ reference: { runId: "run", inputId: "input", taskId: "task" } }, context), /oneOf/);
  await assert.rejects(read.execute({ reference: { runId: "run" } }, context), /required/);
  await assert.rejects(read.execute({ reference: { runId: "run", inputId: "input" }, limit: 101 }, context), /100/);
  read.validate!({ reference: { runId: "run", taskId: "task" }, view: "details", offset: 0, limit: 8000 });
  assert.throws(() => read.validate!({ reference: { runId: "run", taskId: "task" }, limit: 8000 }), /view/);
  assert.throws(() => read.validate!({ reference: { runId: "run", taskId: "task" }, view: "summary", offset: 0 }), /details/);
  assert.throws(() => read.validate!({ reference: { runId: "run", inputId: "input" }, view: "summary" }));
  const image = eris.tools.find(tool => tool.name === "view_image")!;
  await assert.rejects(image.execute({ reference: { runId: "run", inputId: "input" } }, context), /messageIndex/);
  const specialist = eris.tools.find(tool => tool.name === "call_specialist")!;
  const request = { operationId: "6a1b4a17-1039-4ead-ac32-9a37b0bf4ada", kind: "attribution", inputs: [{ runId: "run", inputId: "input" }] };
  await assert.rejects(specialist.execute({ ...request, inputs: [{ runId: "run" }] }, context), /inputId/);
  await assert.rejects(specialist.execute({ ...request, inputs: [{ runId: "run", inputId: "input", taskId: "task" }] }, context), /additional properties/);
  await assert.rejects(specialist.execute({ ...request, attributions: [{ inputId: "input", operationId: request.operationId, runId: "run", taskId: "task" }] }, context), /oneOf/);
  assert.deepEqual(received, [{ limit: 5 }, { runId: "run" }, { runId: "run", query: "A组Fast" }, { runId: "run", view: "comparisons", limit: 1 }], "full directories omit the optional text filter; business filters are forwarded unchanged");
  assert.throws(() => erisPrompt(["list_data", "list_data"]), /Duplicate prompt tool/);
  assert.throws(() => erisPrompt(["unknown_tool"]), /ENOENT/);
});

test("formal and specialist summaries omit evidence while preserving complete commentary and attribution", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
  const evidence = [{ evidence_id: "ev_source_4_text", message_index: 4, quote: "不应挤占点评的长原文".repeat(10000) }];
  const row = { status: "decided", evaluations: { a: { correctness_evidence: evidence,
    findings: [{ finding_id: "f0", type: "problem", text: "把旧数据当作现状", reason: "没有核对数据截止日",
      evidence, assessment: { evidence_status: "established", impact: "结论不可靠" },
      problem: { component: ["模型自身推理"], label: "时效错误", definition: "用过期数据断言现状" } }],
    criterion_assessments: [{ summary: "完成了回答但结论过强", evidence_status: "uncertain", evidence }],
    table_resolutions: [{ outcome: "conflict", reason: "表格口径不一致", evidence }] } },
    verdicts: { a__vs__b: { result: "win", winner_version: "b", reason: "B保留了必要的不确定性" } },
    decision_basis: { tradeoff: "B更稳妥，A更快" },
    rewritten: { evaluator_version: "fixture", rewrites: [{ id: "verdict.A__vs__B.reason", text: "B更好：结论有边界，没有用旧数据断言现状。" }] } };
  const reference = { runId: "run", taskId: "task" };
  const data = { kind: "accepted-result", reference, result: row, evaluatorVersion: "fixture" };
  const original = structuredClone(data);
  const operationId = "6a1b4a17-1039-4ead-ac32-9a37b0bf4ada";
  const specialistResult: SpecialistResult = { operationId, kind: "comparison", state: "succeeded", evaluatorVersion: "fixture",
    result: { comparisons: ["ab", "ac", "bc"].map(taskId => ({ reference: { runId: "run", taskId }, result: row })) } };
  const eris = createEris({ code: { execute: unexpected, read: unexpected },
    data: { list: unexpected, read: async () => data, search: unexpected, image: unexpected },
    specialists: { invoke: async () => specialistResult, read: async () => specialistResult },
    search: { search: unexpected }, web: { read: unexpected } });
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "summary", signal: new AbortController().signal, progress() {} };
  const read = eris.tools.find(tool => tool.name === "read_data")!;
  const result = JSON.parse((await read.execute({ reference }, context)).content[0].text!);
  assert.equal(result.view, "summary");
  assert.equal(Object.keys(result.result)[0], "rewritten", "accepted polished commentary is the first result field");
  assert.deepEqual(result.reference, reference);
  assert.deepEqual(result.result.rewritten, row.rewritten, "accepted polished commentary remains complete, regardless of preceding evidence size");
  assert.deepEqual(result.result.verdicts, row.verdicts);
  assert.deepEqual(result.result.decision_basis, row.decision_basis);
  assert.deepEqual(result.result.evaluations.a.findings[0].problem, row.evaluations.a.findings[0].problem);
  assert.equal(result.result.evaluations.a.findings[0].assessment.evidence_status, "established");
  assert.equal(result.result.evaluations.a.criterion_assessments[0].evidence_status, "uncertain");
  assert.equal(result.result.evaluations.a.correctness_evidence, undefined);
  assert.equal(result.result.evaluations.a.findings[0].evidence, undefined);
  assert.equal(result.result.evaluations.a.criterion_assessments[0].evidence, undefined);
  assert.deepEqual(result.result.evaluations.a.table_resolutions, [{ outcome: "conflict", reason: "表格口径不一致" }]);
  assert.equal(result.text, undefined, "summary is a complete JSON object, never a partial character page");
  assert(JSON.stringify(result).length < 3000);
  const details = JSON.parse((await read.execute({ reference, view: "details", limit: 16000 }, context)).content[0].text!);
  assert.equal(details.text, JSON.stringify(data).slice(0, 16000));
  assert.match(details.text, /ev_source_4_text.*不应挤占点评的长原文/);
  for (const [name, args] of [["read_specialist", { operationId }], ["call_specialist", { operationId, kind: "comparison", inputs: [{ runId: "run", inputId: "a" }, { runId: "run", inputId: "b" }] }]] as const) {
    const receipt = JSON.parse((await eris.tools.find(tool => tool.name === name)!.execute(args, context)).content[0].text!);
    assert.equal(receipt.view, "summary");
    assert.equal(receipt.result.comparisons.length, 3);
    assert.deepEqual(receipt.result.comparisons.map((pair: { reference: unknown }) => pair.reference), ["ab", "ac", "bc"].map(taskId => ({ runId: "run", taskId })));
    for (const pair of receipt.result.comparisons) assert.deepEqual(pair.result, result.result);
  }
  assert.deepEqual(data, original, "projection must never mutate the accepted result or its evidence");
});

test("explicit formal and specialist details are bounded pages with exact continuation", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
  const data = { result: { explanation: "证据🙂".repeat(30000) }, evaluatorVersion: "fixture" };
  const operationId = "6a1b4a17-1039-4ead-ac32-9a37b0bf4ada";
  const eris = createEris({ code: { execute: unexpected, read: unexpected },
    data: { list: unexpected, read: async () => data, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: async () => ({ operationId, kind: "comparison", state: "succeeded", ...data }) },
    search: { search: unexpected }, web: { read: unexpected } });
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "page", signal: new AbortController().signal, progress() {} };
  const read = eris.tools.find(tool => tool.name === "read_data")!;
  const reference = { runId: "run", taskId: "task" };
  const first = JSON.parse((await read.execute({ reference, view: "details" }, context)).content[0].text!);
  assert.equal(first.text.length, 8000);
  assert(first.hasMore);
  const next = JSON.parse((await read.execute({ reference, view: "details", offset: first.nextOffset, limit: 16000 }, context)).content[0].text!);
  assert.equal(first.text + next.text, JSON.stringify(data).slice(0, 24000));
  const specialist = eris.tools.find(tool => tool.name === "read_specialist")!;
  assert.throws(() => specialist.validate!({ operationId, offset: 12000 }), /view/);
  assert.throws(() => specialist.validate!({ operationId, view: "summary", limit: 100 }), /details/);
  const page = JSON.parse((await specialist.execute({ operationId, view: "details", offset: 12000, limit: 100 }, context)).content[0].text!);
  assert.equal(page.result.text, JSON.stringify(data.result).slice(12000, 12100));
  assert.equal(page.state, "succeeded");
  const code = eris.tools.find(tool => tool.name === "execute_code")!;
  assert.equal(code.readOnly, false);
  code.validate!({ language: "python", code: "assert 1 + 1 == 2" });
  assert.throws(() => code.validate!({ language: "python", code: "print(1)", timeout_seconds: 61 }), /60/);
  assert.throws(() => eris.tools.find(tool => tool.name === "read_code_output")!.validate!({ id: "../other-session" }), /schema_pattern/);
});

test("Eris model-facing tool schemas contain no regex lookaround", () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const eris = createEris({ code: { execute: unexpected, read: unexpected }, data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
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
  const eris = createEris({ code: { execute: unexpected, read: unexpected }, data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  const list = eris.tools.find(tool => tool.name === "list_data")!;
  for (const runId of [".", "..", "../run", "a..b", "a..", "a.b..c", "/tmp/run", "a/b", "a\\b", "_run", "-run", "a b", "运行"])
    assert.throws(() => list.validate!({ runId }), /\/runId.*schema_pattern/);
  assert.throws(() => list.validate!({ runId: "" }), /\/runId.*schema_minLength/);
  assert.throws(() => list.validate!({ runId: "a".repeat(182) }), /\/runId.*schema_/);
  for (const runId of ["a", "run", "eval-20261008-134119", "a.b_c-1", "a.", "a.b.", "a.-_b", "a".repeat(181)]) list.validate!({ runId });
  for (const args of [{ limit: "5" }, { runId: null }, { reference: {} }]) {
    const original = structuredClone(args);
    assert.throws(() => list.validate!(args), /参数无效.*未执行/);
    assert.deepEqual(args, original, "validation never coerces types, drops nulls or strips extra fields");
  }
  const search = eris.tools.find(tool => tool.name === "search_web")!;
  assert.throws(() => search.validate!({ queries: [{ query: "report" }], category: "finance" }), /\/category.*allowedValues.*web.*news/);
  const read = eris.tools.find(tool => tool.name === "read_data")!;
  assert.throws(() => read.validate!({ reference: { runId: "run", inputId: "input", offset: 0 } }), /\/reference\/offset.*schema_additionalProperties/);
});

test("cancellation blocks all new tool work", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const control = new AbortController();
  const eris = createEris({ code: { execute: unexpected, read: unexpected }, data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "cancel", signal: control.signal, progress() {} };
  control.abort();
  for (const tool of eris.tools) await assert.rejects(tool.execute({}, context), { name: "AbortError" });
});

test("failed operations are errors while empty search successes and partial receipts stay usable", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  let states: WebSearchAttempt["state"][] = ["failed", "failed"];
  let specialistState: SpecialistResult["state"] = "failed";
  const eris = createEris({ code: { execute: unexpected, read: unexpected }, data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected },
    specialists: { read: unexpected, async invoke(_, request) { return { operationId: request.operationId, kind: request.kind,
      state: specialistState, evaluatorVersion: "fixture", error: "specialist failed" }; } },
    web: { read: unexpected },
    search: { async search() { return { provider: "serper", category: "web", searchedAt: "2026-10-08T00:00:00Z", elapsedMs: 1,
      attempts: states.map((state, queryIndex) => ({ queryIndex, query: "q", searchQuery: "q", country: "cn", language: "zh-cn", page: 1,
        state, resultCount: 0, elapsedMs: 1, ...(state === "failed" ? { error: "HTTP 429" } : {}) })),
      results: [], excludedResults: [], totalUnique: 0, hasMore: false, creditsComplete: false }; } },
  });
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "receipt", signal: new AbortController().signal, progress() {} };
  const search = eris.tools.find(tool => tool.name === "search_web")!;
  for (const sequence of [["failed", "failed"], ["failed", "succeeded"], ["succeeded"]] as WebSearchAttempt["state"][][]) {
    states = sequence;
    const result = await search.execute({ queries: [{ query: "q" }] }, context);
    assert.equal(result.isError, states.every(state => state === "failed"));
    assert.deepEqual(JSON.parse(result.content[0].text!).attempts.map((item: WebSearchAttempt) => item.state), states);
  }
  const specialist = eris.tools.find(tool => tool.name === "call_specialist")!;
  const operationId = "6a1b4a17-1039-4ead-ac32-9a37b0bf4ada";
  for (const state of ["failed", "cancelled", "running", "succeeded"] as const) {
    specialistState = state;
    const result = await specialist.execute({ operationId, kind: "attribution", inputs: [{ runId: "run", inputId: "input" }] }, context);
    assert.equal(result.isError, ["failed", "cancelled"].includes(state));
    assert.equal(JSON.parse(result.content[0].text!).operationId, operationId, "failed receipts retain the operation identity for reconciliation");
  }
});

test("external search validates financial filters and forwards cancellation without source rehydration", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const calls: { request: WebSearchRequest; signal: AbortSignal }[] = [];
  const result = {
    provider: "serper" as const, category: "web" as const, searchedAt: "2026-10-02T00:00:00.000Z", elapsedMs: 100,
    attempts: [], results: [{ title: "利率公告", url: "https://www.pbc.gov.cn/", domain: "www.pbc.gov.cn", snippet: "公告原文入口。", rank: 1, matches: [{ queryIndex: 0, position: 1, page: 1 }], dateAssessment: { status: "not_requested" as const, basis: "none" as const } }],
    excludedResults: [], totalUnique: 1, hasMore: false, credits: 1, creditsComplete: true,
  };
  const eris = createEris({ code: { execute: unexpected, read: unexpected },
    data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected },
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
  ]) await assert.rejects(tool.execute(value, context));
  assert.deepEqual(calls, []);
  const request = { queries: [query], category: "web" as const, dateTo: "2024-07-31", limit: 3 };
  const response = await tool.execute(request, context);
  assert.equal(tool.readOnly, true);
  assert.deepEqual(calls, [{ request, signal: context.signal }]);
  assert.deepEqual(response.content, [{ type: "text", text: JSON.stringify(result) }]);
  assert.equal(response.details, undefined, "search results are durable once; inspection and recovery must not issue a fresh paid search");
});

 test("web reading validates coordinates and stores extracted evidence without a live source reader", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const result: WebReadResult = { url: "https://www.apple.com/report.pdf", requestedUrl: "https://www.apple.com/report.pdf", title: "Annual report", format: "pdf", retrievedAt: "2026-10-02T00:00:00.000Z", elapsedMs: 10, dateAssessment: { status: "unknown", basis: "none" }, lines: [{ number: 12, page: 2, text: "Total net sales 391,035" }], matches: [{ line: 12, page: 2 }], totalLines: 100, totalPages: 3, readPages: 3, nextStartLine: 13, truncated: false, limitations: ["pdf_layout_flattened"] };
  const received: unknown[] = [];
  const eris = createEris({ code: { execute: unexpected, read: unexpected }, data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected }, specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { async read(args, signal) { received.push({ args, signal }); return result; } } });
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
