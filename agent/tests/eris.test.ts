import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createEris, type ErisDependencies } from "@eval/assistant";
import { erisPrompt } from "@eval/prompts";
import type { WebSearchRequest, WebSearchAttempt, WebReadResult, SpecialistResult } from "@eval/contracts";

test('overview material keeps exact counts while case narratives are read explicitly by run', async () => {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected call'); };
  const reference = { runId: 'run', taskId: 'case' };
  const summary = { inputCount: 12, evaluatedInputCount: 10, formalComparisonReferences: [reference],
    formalComparisonStats: { comparisonCount: 3, records: [{ reference, question: 'Only needed for case analysis' }],
      tiers: [{ comparisonTier: 'Fast', comparisonCount: 3, both_good: 1, both_bad: 1, references: [reference], models: [{ wins: 1, losses: 0, both_good: 1, both_bad: 1 }] }] } };
  const original = structuredClone(summary);
  const eris = createEris({ data: { list: async query => query.runId ? { kind: 'inputs', summary } : { kind: 'runs', currentRun: { runId: 'run', summary } }, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected }, save: unexpected });
  const tool = eris.tools.find(t => t.name === 'list_data')!;
  const context = { scope: { userId: 'test', sessionId: 'test' }, callId: 'list', signal: new AbortController().signal, progress() {} };
  const result = JSON.parse((await tool.execute({}, context)).content[0].text!);
  assert.equal(result.currentRun.summary.evaluatedInputCount, 10);
  assert.equal(result.currentRun.summary.inputCount, 12);
  assert.equal(result.currentRun.summary.formalComparisonStats.records, undefined);
  assert.equal(result.currentRun.summary.formalComparisonStats.tiers[0].references, undefined);
  assert.deepEqual(result.currentRun.summary.formalComparisonStats.tiers[0].models, summary.formalComparisonStats.tiers[0].models);
  assert.deepEqual(JSON.parse((await tool.execute({ runId: 'run' }, context)).content[0].text!).summary, original);
  assert.deepEqual(summary, original, 'source values and full provenance remain intact for chart validation');
});

test("Eris's public definition includes every tool resource and validates before invoking dependencies", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const received: unknown[] = [];
  const dependencies: ErisDependencies = {
    data: { list: async (query) => { received.push(query); return { items: [] }; }, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected }, save: unexpected,
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
  assert.deepEqual(received, []);
  const listed = await list.execute({ limit: 5 }, context);
  assert.equal(listed.details, undefined, "business JSON is stored only once");
  await list.execute({ runId: "run" }, context);
  await list.execute({ runId: "run", query: "A组Fast" }, context);
  const read = eris.tools.find(tool => tool.name === "read_data")!;
  assert.match(JSON.stringify(read.inputSchema), /顶层字段，与 reference 同级/);
  const searchTool = eris.tools.find(tool => tool.name === "search_web")!;
  assert.match(JSON.stringify(searchTool.inputSchema), /只有 web（默认）和 news 两个合法值，没有 finance/);
  const chartTool = eris.tools.find(tool => tool.name === "show_chart")!;
  assert(!(chartTool.inputSchema as { required: string[] }).required.includes("references"), "external material charts omit local provenance references");
  await assert.rejects(read.execute({ reference: { runId: "run", inputId: "input", taskId: "task" } }, context), /oneOf/);
  await assert.rejects(read.execute({ reference: { runId: "run" } }, context), /required/);
  await assert.rejects(read.execute({ reference: { runId: "run", inputId: "input" }, limit: 101 }, context), /100/);
  await assert.rejects(read.execute({ reference: { runId: "run", taskId: "task" }, offset: 0 }, context), /NOT be valid/);
  const image = eris.tools.find(tool => tool.name === "view_image")!;
  await assert.rejects(image.execute({ reference: { runId: "run", inputId: "input" } }, context), /messageIndex/);
  const specialist = eris.tools.find(tool => tool.name === "call_specialist")!;
  const request = { operationId: "6a1b4a17-1039-4ead-ac32-9a37b0bf4ada", kind: "attribution", inputs: [{ runId: "run", inputId: "input" }] };
  await assert.rejects(specialist.execute({ ...request, inputs: [{ runId: "run" }] }, context), /inputId/);
  await assert.rejects(specialist.execute({ ...request, inputs: [{ runId: "run", inputId: "input", taskId: "task" }] }, context), /additional properties/);
  await assert.rejects(specialist.execute({ ...request, attributions: [{ inputId: "input", operationId: request.operationId, runId: "run", taskId: "task" }] }, context), /oneOf/);
  const summary = eris.tools.find(tool => tool.name === "save_summary")!;
  await assert.rejects(summary.execute({ markdown: "summary", references: [{ reference: { runId: "run", inputId: "input" } }] }, context), /additional properties/);
  await assert.rejects(summary.execute({ markdown: "summary", references: [{ reference: { runId: "run", taskId: "task" }, operationId: request.operationId }] }, context), /oneOf/);
  assert.deepEqual(received, [{ limit: 5 }, { runId: "run" }, { runId: "run", query: "A组Fast" }], "full directories omit the optional text filter; business filters are forwarded unchanged");
  assert.throws(() => erisPrompt(["list_data", "list_data"]), /Duplicate prompt tool/);
  assert.throws(() => erisPrompt(["unknown_tool"]), /ENOENT/);
});

test("raw arguments fail with field paths and allowed values before SDK coercion or I/O", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const eris = createEris({ data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected }, save: unexpected });
  const list = eris.tools.find(tool => tool.name === "list_data")!;
  for (const runId of [".", "..", "../run", "a..b", "/tmp/run"]) assert.throws(() => list.validate!({ runId }), /\/runId.*schema_pattern/);
  for (const runId of ["run", "eval-20261008-134119", "a.b_c-1"]) list.validate!({ runId });
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

test("cancellation blocks all new work and a summary write after source verification", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const control = new AbortController();
  const eris = createEris({ data: { list: unexpected, search: unexpected, image: unexpected,
    async read() { control.abort(); return { result: {}, evaluatorVersion: "fixture" }; } },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected }, save: unexpected });
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "cancel", signal: control.signal, progress() {} };
  const save = eris.tools.find(tool => tool.name === "save_summary")!;
  await assert.rejects(save.execute({ markdown: "summary", references: [{ reference: { runId: "run", taskId: "task" } }] }, context), { name: "AbortError" });
  for (const tool of eris.tools) await assert.rejects(tool.execute({}, context), { name: "AbortError" });
});

test("failed operations are errors while empty search successes and partial receipts stay usable", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  let states: WebSearchAttempt["state"][] = ["failed", "failed"];
  let specialistState: SpecialistResult["state"] = "failed";
  const eris = createEris({ data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected },
    specialists: { read: unexpected, async invoke(_, request) { return { operationId: request.operationId, kind: request.kind,
      state: specialistState, evaluatorVersion: "fixture", error: "specialist failed" }; } },
    web: { read: unexpected }, save: unexpected,
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
  const eris = createEris({
    data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, save: unexpected,
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

test("summaries keep verified source locators in metadata instead of the delivered Markdown", async () => {
  const operationId = "6a1b4a17-1039-4ead-ac32-9a37b0bf4ada";
  const reference = { runId: "evaluation-internal", taskId: "comparison-internal" };
  const saved: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const eris = createEris({
    data: {
      list: unexpected, search: unexpected, image: unexpected,
      read: async (ref) => ref.taskId === reference.taskId ? { result: { conclusion: "模型 A 回答正确。" }, evaluatorVersion: "fixture" } : {},
    },
    specialists: {
      invoke: unexpected,
      read: async (_, id) => ({ operationId: id, kind: "comparison", state: id === operationId ? "succeeded" : "running", evaluatorVersion: "fixture", reference }),
    },
    search: { search: unexpected }, web: { read: unexpected },
    save: async (_, markdown) => { saved.push(markdown); return { name: "summary.md", url: "/summary.md" }; },
  });
  const summary = eris.tools.find(tool => tool.name === "save_summary")!;
  const context = { scope: { userId: "alice", sessionId: "session" }, callId: "summary", signal: new AbortController().signal, progress() {} };
  const markdown = "模型 A 回答正确。\n\n依据：回答给出了可核对的计算过程。";
  const result = await summary.execute({ markdown, references: [{ operationId }, { reference }] }, context);
  assert.deepEqual(saved, [markdown]);
  assert.deepEqual(result.details, { references: [
    { operationId, evaluatorVersion: "fixture", reference },
    { reference, evaluatorVersion: "fixture" },
  ] });
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ name: "summary.md", url: "/summary.md" }) }]);
  await assert.rejects(summary.execute({ markdown, references: [{ operationId: "51b9dc2a-1292-4c4c-a71d-2db0b3f64d96" }] }, context), /已接受/);
  await assert.rejects(summary.execute({ markdown, references: [{ operationId }, { reference: { ...reference, taskId: "missing" } }] }, context), /正式结果不存在/);
  assert.deepEqual(saved, [markdown], "every reference is verified before writing an artifact");
});

 test("web reading validates coordinates and stores extracted evidence without a live source reader", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const result: WebReadResult = { url: "https://www.apple.com/report.pdf", requestedUrl: "https://www.apple.com/report.pdf", title: "Annual report", format: "pdf", retrievedAt: "2026-10-02T00:00:00.000Z", elapsedMs: 10, dateAssessment: { status: "unknown", basis: "none" }, lines: [{ number: 12, page: 2, text: "Total net sales 391,035" }], matches: [{ line: 12, page: 2 }], totalLines: 100, totalPages: 3, readPages: 3, nextStartLine: 13, truncated: false, limitations: ["pdf_layout_flattened"] };
  const received: unknown[] = [];
  const eris = createEris({ data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected }, specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { async read(args, signal) { received.push({ args, signal }); return result; } }, save: unexpected });
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
