import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, object, type AttemptSpec } from "@eval/contracts";
import { body, listen } from "@eval/runtime/http";
import { piBackend } from "@eval/runtime/pi";
import { fakeIdentity } from "../fixtures/comparison.js";

const call = (id: string, args = "") => ({
  type: "function_call", id: `fc_${id}`, call_id: `call_${id}`,
  name: "submit_evaluation", arguments: args,
});
const itemEvent = (type: "added" | "done", output_index: number, item: Record<string, unknown>) => ({
  type: `response.output_item.${type}`, output_index, item,
});
const terminal = (output: Record<string, unknown>[]) => ({
  type: "response.completed",
  response: { id: "resp_fixture", status: "completed", output,
    usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27,
      input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } },
});

async function replay(events: Record<string, unknown>[], debug = false, readBatch = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-pi-responses-"));
  const requests: Record<string, unknown>[] = [], executed: unknown[] = [];
  const errors: string[] = [], ended: unknown[] = [], messages: Record<string, unknown>[] = [];
  const providerArguments: Record<string, unknown>[] = [];
  let activeTools = 0, peakActiveTools = 0;
  const gateway = await listen(async (req, res) => {
    requests.push(object(await body(req)));
    assert(requests.length <= 2, "replay must terminate after returning the tool result");
    const responseEvents = requests.length === 1 ? events : [terminal([])];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(responseEvents.map((event, sequence_number) =>
      `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
    ).join(""));
  });
  const keyName = "SDK_RESPONSES_REPLAY_KEY", previous = process.env[keyName], previousOffline = process.env.PI_OFFLINE;
  process.env[keyName] = "local-fixture-secret";
  process.env.PI_OFFLINE = "1";
  try {
    const identity = { ...fakeIdentity, engine: "pi" as const };
    const spec: AttemptSpec = {
      runId: "responses-test", debug, taskId: "task", attemptId: "attempt", inputRevision: 1,
      engine: identity, evidenceBank: [],
      evaluation: { id: "fixture", profile: "default", systemPrompt: "Submit the value.",
        outputSchema: { type: "object" }, toolNames: readBatch ? ["read_trace"] : [], fileSubmission: false,
        toolDescriptions: {}, submissionNudge: "Submit." },
      model: { provider: "fixture", baseUrl: gateway.url + "/v1", api: "openai-responses", apiKeyEnv: keyName,
        model: "fixture", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 },
      policy: DEFAULT_POLICY, prompt: "fixture", inputs: [], hostUrl: gateway.url, deadline: Date.now() + 10000,
    };
    const session = await piBackend(identity).createSession({
      spec, workdir: directory,
      tools: (readBatch ? ["read_trace", "submit_evaluation"] : ["submit_evaluation"]).map(name => ({ name, description: "Read or submit the value.",
        inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
        async execute() { return { content: [] }; } })),
      async execute(_name, args) {
        activeTools++; peakActiveTools = Math.max(peakActiveTools, activeTools);
        executed.push(structuredClone(args));
        if (readBatch) await new Promise(resolve => setTimeout(resolve, 5));
        activeTools--;
        return { content: [{ type: "text", text: "accepted" }],
          ...(readBatch ? { details: { budget: { exploration: { remaining: Math.max(0, 2 - executed.length) } } } } : {}) };
      },
      onEvent(value) {
        const event = object(value);
        if (event.type === "provider_tool_arguments") providerArguments.push(structuredClone(event));
        if (event.type === "message_update") {
          const update = object(event.assistantMessageEvent);
          if (update.type === "toolcall_end") ended.push(structuredClone(object(update.toolCall).arguments));
        }
        if (event.type !== "message_end") return;
        const message = object(event.message);
        if (message.role !== "assistant") return;
        messages.push(structuredClone(message));
        if (message.stopReason === "error") errors.push(String(message.errorMessage));
      },
    });
    try { await session.run(spec.prompt); } finally { await session.dispose(); }
    return { requests, executed, errors, ended, messages, providerArguments, peakActiveTools };
  } finally {
    if (previous === undefined) delete process.env[keyName];
    else process.env[keyName] = previous;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("pi: independent navigation reads share one response and execute serially before the next model request", async () => {
  const calls = ["第一段原文", "第二段原文"].map((value, index) => ({ ...call(String(index), JSON.stringify({ value })), name: "read_trace" }));
  const result = await replay([...calls.flatMap((item, index) => [itemEvent("added", index, { ...item, arguments: "" }),
    itemEvent("done", index, item)]), terminal(calls)], false, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.executed, [{ value: "第一段原文" }, { value: "第二段原文" }]);
  assert.equal(result.peakActiveTools, 1, "batched generation must not race evidence or budget mutation");
  assert.equal(result.requests.length, 2, "both reads finish without an intervening model request");
  assert.equal(result.requests[0].parallel_tool_calls, true);
  assert.equal(result.requests[1].parallel_tool_calls, false, "the exhausted exploration budget still closes reading tools");
  assert.deepEqual((result.requests[1].tools as { name: string }[]).map(tool => tool.name), ["submit_evaluation"]);
  assert.deepEqual((result.requests[1].input as { type?: string; call_id?: string }[])
    .filter(item => item.type === "function_call_output").map(item => item.call_id), ["call_0", "call_1"]);
});

for (const status of ["completed", "incomplete"] as const)
test(`pi: only debug records original malformed arguments in ${status} Responses`, async () => {
  const args = '{"value":"unterminated';
  for (const debug of [false, true]) {
    const response = terminal([call("raw", args)]).response;
    const result = await replay([itemEvent("added", 0, call("raw")), itemEvent("done", 0, call("raw", args)),
      { type: `response.${status}`, response: { ...response, status,
        ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}) } }], debug);
    assert.deepEqual(result.executed, []);
    assert.deepEqual(result.providerArguments, debug ? [{ type: "provider_tool_arguments", response_id: "resp_fixture", status,
      calls: [{ id: "fc_raw", call_id: "call_raw", name: "submit_evaluation", arguments: args }] }] : []);
    assert.equal(result.messages[0].stopReason, status === "incomplete" ? "length" : "error");
    assert.equal(result.requests.length, status === "incomplete" ? 2 : 1);
  }
});

for (const completed of [false, true]) {
test(`pi: plain text Responses ${completed ? "accept a completed terminal without usage" : "reject EOF without a terminal event"}`, async () => {
  const message = { type: "message", id: "msg_text", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "complete-looking text", annotations: [] }] };
  const events: Record<string, unknown>[] = [
    itemEvent("added", 0, { ...message, content: [] }), itemEvent("done", 0, message),
  ];
  // Both variants lack usage; only an authoritative terminal event makes the SDK successful.
  if (completed) events.push({ type: "response.completed", response: { id: "resp_text", status: "completed", output: [message] } });
  const result = await replay(events);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.executed, []);
  assert.deepEqual(result.ended, []);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].stopReason, completed ? "stop" : "error");
  assert.equal(object((result.messages[0].content as unknown[])[0]).text, "complete-looking text");
  if (completed) assert.deepEqual(result.errors, []);
  else {
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /stream ended before a terminal response event/);
  }
});
}

for (const streamed of [false, true]) {
test(`pi: ${streamed ? "fragmented" : "terminal"} Responses preserve current flat comparison arrays and escaped text`, async () => {
  const draft = {
    assessments:[{candidate:"A",meets_core:true,summary:'原文含 "引号"、\\ 路径和\n换行',core_failure_refs:[]},
      {candidate:"B",meets_core:false,summary:"B 给出了不同结果。",core_failure_refs:[]}],
    comparisons:[{slot_index:0,kind:"criterion",importance:"high",better_candidate:"A",assessments:[
      {candidate:"A",summary:"正确。",finding_indices:[],status:"met",evidence_status:"已确认"},
      {candidate:"B",summary:"错误。",finding_indices:[],status:"unmet",evidence_status:"已确认"}]}],
    quality_winner:"A",relative_preference:"A",tradeoff:"【候选A】给出正确结果4，【候选B】给出错误结果5。",
  };
  const args = JSON.stringify(draft);
  const deltas = streamed ? Array.from(args).map(delta => ({ type: "response.function_call_arguments.delta",
    output_index: 0, item_id: "fc_nested", delta })) : [];
  const result = await replay([itemEvent("added", 0, call("nested")), ...deltas,
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_nested", arguments: args },
    itemEvent("done", 0, call("nested", args)), terminal([call("nested", args)])], true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.executed, [draft], "the SDK must dispatch the complete current payload without changing field order or text");
  assert.deepEqual(result.ended, result.executed);
  assert.equal(result.requests.length, 2);
  assert.equal(object((result.providerArguments[0].calls as Record<string, unknown>[])[0]).arguments, args);
});
}

test(`pi: terminal Responses arguments reach the tool when a gateway sends item.done before its delta`, async () => {
  // Minimal event ordering from the captured MiniMax stream; no evaluation material is needed.
  const args = '{"value":"accepted"}';
  const result = await replay([
    itemEvent("added", 0, call("late")),
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_late", arguments: "" },
    itemEvent("done", 0, call("late")),
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_late", delta: args },
    terminal([call("late", args)]),
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.executed, [{ value: "accepted" }]);
  assert.deepEqual(result.ended, result.executed, "toolcall_end must contain the final arguments at emission time");
  assert.equal(result.requests.length, 2);
});

test(`pi: terminal Responses calls match by identity while interleaved tools, text, reasoning and usage survive`, async () => {
  const a = '{"value":"first"}', b = '{"value":"second"}';
  const thinking = { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "checked" }] };
  const message = { type: "message", id: "msg_fixture", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "ready", annotations: [] }] };
  const result = await replay([
    itemEvent("added", 0, thinking), itemEvent("done", 0, thinking),
    itemEvent("added", 1, call("a")), itemEvent("added", 2, call("b")),
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_b", delta: b },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_a", delta: a },
    itemEvent("done", 2, call("b", b)), itemEvent("done", 1, call("a", a)),
    itemEvent("added", 3, message), itemEvent("done", 3, message),
    terminal([thinking, call("b", b), call("a", a), message]),
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.executed, [{ value: "first" }, { value: "second" }]);
  assert.deepEqual(result.ended.toSorted((x, y) => String(object(x).value).localeCompare(String(object(y).value))), result.executed);
  assert.deepEqual((result.messages[0].content as Record<string, unknown>[]).map((part) => part.type), ["thinking", "toolCall", "toolCall", "text"]);
  assert.equal((result.messages[0].content as Record<string, unknown>[])[0].thinking, "checked");
  assert.equal((result.messages[0].content as Record<string, unknown>[])[3].text, "ready");
  assert.equal(object(result.messages[0].usage).input, 17);
  assert.equal(object(result.messages[0].usage).cacheRead, 3);
  assert.equal(object(result.messages[0].usage).output, 7);
});

for (const argumentsJson of ['{"value":', "null", "[]", '"text"', ""]) {
  test(`pi: rejects malformed terminal tool arguments ${JSON.stringify(argumentsJson)} without executing partial values`, async () => {
    const result = await replay([
      itemEvent("added", 0, call("invalid")),
      itemEvent("done", 0, call("invalid", '{"value":"must not run"}')),
      terminal([call("invalid", argumentsJson)]),
    ]);
    assert.deepEqual(result.executed, []);
    assert.deepEqual(result.ended, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Invalid OpenAI Responses tool arguments/);
    assert.equal(result.requests.length, 1);
  });
}

for (const changed of [{ call_id: "call_other" }, { id: "fc_other" }]) {
test(`pi: rejects terminal function identity conflicts in ${Object.keys(changed)[0]}`, async () => {
  const result = await replay([
    itemEvent("added", 0, call("identity")),
    itemEvent("done", 0, call("identity", '{"value":"must not run"}')),
    terminal([{ ...call("identity", '{"value":"wrong call"}'), ...changed }]),
  ]);
  assert.deepEqual(result.executed, []);
  assert.deepEqual(result.ended, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /OpenAI Responses tool identity mismatch/);
});
}

for (const changed of [{ call_id: "call_other" }, { id: "fc_other" }, { name: "different_tool" }]) {
test(`pi: rejects function identity changes between item.added and item.done in ${Object.keys(changed)[0]}`, async () => {
  const completed = { ...call("changed", '{"value":"must not run"}'), ...changed };
  const result = await replay([
    itemEvent("added", 0, call("changed")), itemEvent("done", 0, completed), terminal([completed]),
  ]);
  assert.deepEqual(result.executed, []);
  assert.deepEqual(result.ended, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /identity mismatch|function call was not finalized/i);
});
}

test(`pi: rejects duplicate streamed function identities before an overwritten call can execute`, async () => {
  const args = '{"value":"must not run"}';
  const result = await replay([
    itemEvent("added", 0, call("duplicate")), itemEvent("added", 1, call("duplicate")),
    itemEvent("done", 0, call("duplicate", args)), itemEvent("done", 1, call("duplicate", args)),
    terminal([call("duplicate", args)]),
  ]);
  assert.deepEqual(result.executed, []);
  assert.deepEqual(result.ended, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /duplicate.*function.*identity/i);
});

test(`pi: rejects a tool call without item.done even when the terminal response contains arguments`, async () => {
  const args = '{"value":"must not run"}';
  const result = await replay([
    itemEvent("added", 0, call("unfinished")),
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_unfinished", delta: args },
    terminal([call("unfinished", args)]),
  ]);
  assert.deepEqual(result.executed, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /unfinished tool call|function call was not finalized/i);
});

test(`pi: incomplete Responses retain length status and never execute a tool`, async () => {
  const args = '{"value":"must not run"}';
  const response = terminal([call("truncated", args)]).response;
  const result = await replay([
    itemEvent("added", 0, call("truncated")),
    itemEvent("done", 0, call("truncated", args)),
    { type: "response.incomplete", response: { ...response, status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" } } },
  ]);
  assert.deepEqual(result.executed, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.messages[0].stopReason, "length");
});
