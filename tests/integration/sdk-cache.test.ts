import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, object, type AttemptSpec } from "@eval/contracts";
import { body, listen } from "@eval/runtime/http";
import { piBackend } from "@eval/runtime/pi";
import { primeBackend } from "@eval/runtime/prime";
import { fakeIdentity } from "../fixtures/comparison.js";

for (const engine of ["pi", "prime"] as const)
  test(`${engine}: Responses cache controls reach the gateway and repairs preserve task history`, { timeout: 60000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eval-sdk-cache-"));
    const requests: Record<string, unknown>[] = [];
    const gateway = await listen(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer local-fixture-secret");
      requests.push(object(await body(req)));
      const call = { type: "function_call", id: "fc_repair", call_id: "call_repair", name: "submit_evaluation", arguments: "{}" };
      const events: Record<string, unknown>[] = requests.length === 1 ? [
        { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item: call },
      ] : [];
      events.push({
        type: "response.completed",
        response: { id: `resp_${requests.length}`, status: "completed", output: requests.length === 1 ? [call] : [],
          usage: { input_tokens: 20, output_tokens: 1, total_tokens: 21 } },
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((event, sequence_number) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
      ).join(""));
    });
    const keyName = "SDK_CACHE_TEST_KEY";
    const previous = process.env[keyName];
    const previousOffline = process.env.PI_OFFLINE;
    process.env[keyName] = "local-fixture-secret";
    process.env.PI_OFFLINE = "1";
    const backend = (engine === "pi" ? piBackend : primeBackend)({ ...fakeIdentity, engine });
    let executed = 0;
    try {
      for (const [index, toolNames] of [[], [], ["read_trace"]].entries()) {
        const spec: AttemptSpec = {
          runId: "cache-test", taskId: `task-${index}`, attemptId: `attempt-${index}`, inputRevision: 1,
          engine: backend.identity,
          evaluation: { id: "fixture", profile: "default", systemPrompt: "Preserve these exact rules.",
            outputSchema: { type: "object" }, toolNames, fileSubmission: false, toolDescriptions: {}, submissionNudge: "Submit." },
          model: { provider: "fixture", baseUrl: gateway.url + "/v1", api: "openai-responses", apiKeyEnv: keyName,
            model: "gpt-6-luna", thinking: "high", contextWindow: 200000, maxOutputTokens: 8192 },
          policy: DEFAULT_POLICY, prompt: `Exact material ${index}`, inputs: [], hostUrl: gateway.url,
          deadline: Date.now() + 30000,
        };
        const errors: string[] = [];
        const session = await backend.createSession({
          spec, workdir: path.join(directory, spec.attemptId),
          tools: [{ name: "submit_evaluation", description: "Preserve this description.",
            inputSchema: { type: "object", properties: {} },
            async execute() { return { content: [] }; } }],
          async execute() {
            executed++;
            return { isError: true, content: [{ type: "text", text: "Repair the rejected field." }] };
          },
          onEvent(value) {
            const event = object(value);
            if (event.type !== "message_end") return;
            const message = object(event.message);
            if (message.stopReason === "error") errors.push(String(message.errorMessage));
          },
        });
        try { await session.run(spec.prompt); } finally { await session.dispose(); }
        assert.deepEqual(errors, []);
      }
      assert.equal(executed, 1);
      assert.equal(requests.length, 4);
      assert.deepEqual(requests.map((r) => r.prompt_cache_options), [
        { mode: "explicit" }, { mode: "implicit" }, { mode: "explicit" }, { mode: "implicit" },
      ]);
      for (const payload of requests) {
        assert.equal(payload.prompt_cache_key, "evaluation");
        assert.equal(payload.max_output_tokens, 8192);
        assert.equal(payload.parallel_tool_calls, false);
        assert.equal(object(payload.reasoning).effort, "high");
        assert(!Object.hasOwn(payload, "prompt_cache_retention"));
        assert(JSON.stringify(payload.input).includes("Preserve these exact rules."));
        assert.deepEqual((payload.tools as { name: string }[]).map((tool) => tool.name), ["submit_evaluation"]);
        assert(JSON.stringify(payload.tools).includes("Preserve this description."));
      }
      const firstInput = requests[0].input as unknown[];
      const repairInput = requests[1].input as unknown[];
      assert.deepEqual(repairInput.slice(0, firstInput.length), firstInput);
      assert(JSON.stringify(repairInput).includes("Repair the rejected field."));
      assert(!JSON.stringify(requests[2].input).includes("Exact material 0"), "cache keys must not share conversation history");
    } finally {
      if (previous === undefined) delete process.env[keyName];
      else process.env[keyName] = previous;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
