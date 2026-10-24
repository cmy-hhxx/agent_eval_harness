const INPUT_ID = "11111111-1111-4111-8111-111111111111";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, resolveEvidenceSelection, requiredReadCallLimit, toolBudgetMetadataChars, type ToolContext, type TraceRead } from "@eval/contracts";
import { ArtifactStore } from "@eval/data";
import { createRegistry, resolveEvidence, selectEvidenceSource, evidenceSources, ToolRuntime } from "./index.js";
import { RequiredReadBudget } from "./required-reading.js";

const target = (start: number, end: number, path = "/content"): TraceRead => ({
  candidate: "answer", message_index: 0, kind: "text", path, start, end,
});
const inputs = (text = "abcdefgh") => new Map<string, unknown>([["answer", { messages: [{ content: text }] }]]);
const argumentsFor = (offset = 0, path = "/content") => ({ candidate: "answer", message_index: 0, path, offset });
const metadataChars = toolBudgetMetadataChars(["read_trace"]);

test("trusted overlapping, duplicate and adjacent ranges share one coverage allowance", () => {
  const budget = new RequiredReadBudget(inputs(), new Map([["answer", INPUT_ID]]), [target(0, 4), target(2, 6), target(0, 4), target(6, 8)], 4096, metadataChars);
  const before = { traceReads: [] as TraceRead[] };
  assert.equal(budget.limit, 2);
  assert.equal(budget.isRequired(argumentsFor(), before), true);
  assert.equal(budget.isRequired(argumentsFor(2), before), false);
  assert.equal(budget.charge(argumentsFor(), target(0, 4), before), true);
  assert.equal(budget.used, 1);
  assert.equal(budget.isRequired(argumentsFor(), before), false, "already charged pages cannot be free again through a stale audit");
  assert.equal(budget.isRequired(argumentsFor(4), before), true);
  assert.equal(budget.charge(argumentsFor(4), target(4, 8), before), true);
  assert.equal(budget.remaining, 0);
});

test("each independent range advances from its first uncovered position", () => {
  const budget = new RequiredReadBudget(inputs(), new Map([["answer", INPUT_ID]]), [target(0, 3), target(5, 8)], 4096, metadataChars);
  const audit = { traceReads: [target(0, 1), target(2, 3)] };
  assert.equal(budget.isRequired(argumentsFor(1), audit), true);
  assert.equal(budget.isRequired(argumentsFor(2), audit), false);
  assert.equal(budget.isRequired(argumentsFor(5), audit), true);
  assert.equal(budget.isRequired(argumentsFor(6), audit), false);
  assert.equal(budget.isRequired(argumentsFor(3), audit), false);
  assert.equal(budget.isRequired(argumentsFor(), { traceReads: [target(0, 8)] }), false);
});

test("only requests covering a full mandatory page or its remaining short range qualify", () => {
  const budget = new RequiredReadBudget(inputs(), new Map([["answer", INPUT_ID]]), [target(0, 8)], 4096, metadataChars);
  const audit = { traceReads: [] };
  assert.equal(budget.isRequired({ ...argumentsFor(), max_chars: 16000 }, audit), true);
  assert.equal(budget.isRequired({ ...argumentsFor(), max_chars: 8 }, audit), true);
  assert.equal(budget.isRequired({ ...argumentsFor(), max_chars: 12000 }, audit), true);
  for (const args of [
    { ...argumentsFor(), max_chars: 1 }, { ...argumentsFor(), max_chars: 7 }, { ...argumentsFor(), max_chars: 16001 },
    { ...argumentsFor(), candidate: "other" }, { ...argumentsFor(), message_index: 1 },
    { ...argumentsFor(), path: "/other" }, { ...argumentsFor(), path: undefined },
    { ...argumentsFor(), offset: -1 }, { ...argumentsFor(), offset: 0.5 },
    { ...argumentsFor(), extra: true }, null,
  ]) assert.equal(budget.isRequired(args, audit), false);
  const stringSource = new Map<string, unknown>([["answer", { messages: ["abc"] }]]);
  const emptyPath = new RequiredReadBudget(stringSource, new Map([["answer", INPUT_ID]]), [target(0, 3, "")], 4096, metadataChars);
  assert.equal(emptyPath.isRequired(argumentsFor(0, ""), audit), true);
});

test("failed, empty, mismatched and repeated returned ranges do not consume required quota", () => {
  const budget = new RequiredReadBudget(inputs(), new Map([["answer", INPUT_ID]]), [target(0, 8)], 4096, metadataChars);
  const audit = { traceReads: [] };
  for (const returned of [target(0, 0), target(1, 3), target(0, 9), { ...target(0, 3), kind: "json" as const },
    { ...target(0, 3), candidate: "other" }])
    assert.equal(budget.charge(argumentsFor(), returned, audit), false);
  assert.equal(budget.used, 0);
  assert.equal(budget.charge(argumentsFor(), target(0, 8), audit), true);
  assert.equal(budget.charge(argumentsFor(), target(0, 8), audit), false);
  assert.equal(budget.used, 1);
  assert.equal(budget.isRequired(argumentsFor(), audit), false);
});

test("required quota remains finite even if a caller reports tiny new ranges", () => {
  const budget = new RequiredReadBudget(inputs(), new Map([["answer", INPUT_ID]]), [target(0, 8)], 4096, metadataChars);
  const audit = { traceReads: [] };
  assert.equal(budget.charge(argumentsFor(), target(0, 1), audit), true);
  assert.equal(budget.charge(argumentsFor(1), target(1, 2), audit), true);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.isRequired(argumentsFor(2), audit), false);
  assert.equal(budget.charge(argumentsFor(2), target(2, 3), audit), false);
});

test("an exact JSON field uses mandatory quota with no exploration and preserves its JSON coordinates", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "eval-required-json-"));
  try {
    const raw = { messages: [{ output: { asset: "GLD.P", unit: "$", price: 369 } }] };
    const range = selectEvidenceSource(evidenceSources(raw.messages[0]), "/output/price")!;
    const target = { candidate: "answer", message_index: 0, kind: "json" as const, path: "", start: range.start, end: range.end };
    const context: ToolContext = { inputIds: new Map([["answer", INPUT_ID]]), inputs: new Map([["answer", raw]]),
      attemptId: "required-json", workdir, audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] },
      policy: { ...DEFAULT_POLICY, maxToolCalls: 0, maxOutputChars: 1024 }, requiredReads: [target],
      artifacts: new ArtifactStore(path.join(workdir, "artifacts")) };
    const runtime = new ToolRuntime(context, createRegistry().select(["read_trace"]));
    const result = await runtime.execute("read_trace", { candidate: "answer", message_index: 0, path: "", offset: range.start,
      max_chars: range.end - range.start }, new AbortController().signal);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const page = result.details as { source: { kind: string }; evidence: { quote: string }[]; text_sources?: unknown };
    assert.equal(page.source.kind, "json");
    assert.equal(page.text_sources, undefined);
    assert.match(page.evidence[0].quote, /"price":\s*369/u);
    assert.equal(context.audit.requiredReadCalls, 1);
    assert.equal(runtime.budget().required_reads.covered, true);
  } finally { await rm(workdir, { recursive: true, force: true }); }
});

for (const [name, text] of [
  ["plain long text", "核".repeat(50000)],
  ["serialized quotes, control characters and surrogate boundaries", ('值"\\\n🙂\u0001\ud800').repeat(7000)],
]) test(`mandatory ${name} finishes through real 1024-character pages with no exploration allowance`, async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "eval-required-reading-"));
  try {
    const context: ToolContext = {
      inputIds: new Map([["answer", INPUT_ID]]), attemptId: "required-reading-test", workdir, inputs: inputs(text),
      audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] },
      policy: { ...DEFAULT_POLICY, maxToolCalls: 0, maxOutputChars: 1024 },
      requiredReads: [target(0, text.length)],
      artifacts: new ArtifactStore(path.join(workdir, "artifacts")),
    };
    const runtime = new ToolRuntime(context, createRegistry().select(["read_trace"]));
    const limit = runtime.budget().required_reads.remaining;
    assert(Number.isSafeInteger(limit) && limit > 0, "mandatory reading has a finite allowance");
    let offset = 0, recovered = "";
    while (offset < text.length) {
      const result = await runtime.execute("read_trace", argumentsFor(offset), new AbortController().signal);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const page = result.details as { evidence: { quote: string }[]; selection_path: string; next_offset: number; has_more: boolean };
      assert.equal(page.selection_path, "/content");
      assert(result.content.map((item) => item.text ?? "").join("\n").length <= context.policy.maxOutputChars);
      assert(page.next_offset > offset && page.next_offset <= text.length);
      assert.equal(page.has_more, page.next_offset < text.length);
      recovered += page.evidence.map((evidence) => evidence.quote).join("");
      offset = page.next_offset;
      const budget = runtime.budget();
      assert.equal(budget.exploration.used, 0);
      assert.equal(budget.required_reads.used + budget.required_reads.remaining, limit);
    }
    assert.equal(recovered, text, "every source character is returned by actual read_trace pages");
    const budget = runtime.budget();
    assert.equal(budget.required_reads.covered, true);
    assert(budget.required_reads.used > 14);
    assert.equal(context.audit.calls, budget.required_reads.used);
    assert.equal(context.audit.requiredReadCalls, budget.required_reads.used);
    assert.equal((await runtime.execute("read_trace", argumentsFor(), new AbortController().signal)).isError, true,
      "completed mandatory reads cannot bypass the exhausted exploration allowance");
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("long mandatory text reserves the full writer budget envelope in both paging and its finite quota", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "eval-required-writer-budget-"));
  try {
    const text = "完整证据🙂\n".repeat(60000);
    const source = { messages: [{ content: text }] };
    const writers = Array.from({ length: 12 }, (_, index) => ({
      name: `save_${"fixture_".repeat(6)}${index}`, fileWriter: true,
      inputSchema: { type: "object" },
      async execute() { return { content: [{ type: "text" as const, text: "saved" }] }; },
    }));
    const toolNames = ["read_trace", ...writers.map(writer => writer.name)];
    const reserved = toolBudgetMetadataChars(toolNames);
    assert(reserved > 200, "registered writer names and all counters must fit the budget JSON");
    const context: ToolContext = {
      inputIds: new Map([["answer", INPUT_ID]]), attemptId: "long-writer-budget", workdir, inputs: new Map([["answer", source]]),
      audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] },
      policy: { ...DEFAULT_POLICY, maxToolCalls: 0, maxOutputChars: 16000 },
      requiredReads: [target(0, text.length)],
      artifacts: new ArtifactStore(path.join(workdir, "artifacts")),
    };
    const runtime = new ToolRuntime(context, createRegistry(writers).select(toolNames));
    const limit = requiredReadCallLimit([{ target: target(0, text.length), inputId: INPUT_ID, text }], context.policy.maxOutputChars, reserved);
    assert.equal(runtime.budget().required_reads.remaining, limit, "Host and Worker derive the same finite allowance");
    let offset = 0, recovered = "";
    while (offset < text.length) {
      const result = await runtime.execute("read_trace", argumentsFor(offset), new AbortController().signal);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert(result.content.map(item => item.text ?? "").join("\n").length <= context.policy.maxOutputChars);
      const page = result.details as { evidence: { reference: { evidence_index: number }; quote: string }[]; next_offset: number };
      for (const evidence of page.evidence) {
        assert.equal(resolveEvidence(source, resolveEvidenceSelection(context.audit.evidenceBank!, evidence.reference, "/reference"), "answer", context.audit, "/evidence", INPUT_ID).quote, evidence.quote);
        recovered += evidence.quote;
      }
      assert(page.next_offset > offset);
      offset = page.next_offset;
    }
    assert.equal(recovered, text);
    assert.equal(runtime.budget().required_reads.covered, true);
    assert(context.audit.requiredReadCalls <= limit);
  } finally { await rm(workdir, { recursive: true, force: true }); }
});
test("invalid trusted coordinates fail immediately and empty ranges need no allowance", () => {
  assert.equal(new RequiredReadBudget(inputs(), new Map([["answer", INPUT_ID]]), undefined, 4096, metadataChars).limit, 0);
  assert.equal(new RequiredReadBudget(inputs(), new Map([["answer", INPUT_ID]]), [target(3, 3)], 4096, metadataChars).limit, 0);
  for (const invalid of [target(-1, 3), target(4, 3), target(0, 9), target(0.5, 3),
    { ...target(0, 3), kind: "json" as const }, { ...target(0, 3), candidate: "other" },
    { ...target(0, 3), message_index: 1 }, target(0, 3, "/missing")])
    assert.throws(() => new RequiredReadBudget(inputs(), new Map([["answer", INPUT_ID]]), [invalid], 4096, metadataChars), RangeError);
  assert.throws(() => new RequiredReadBudget(inputs(), new Map([["answer", INPUT_ID]]), [target(0, 8)], 128, metadataChars), /输出预算/);
});
