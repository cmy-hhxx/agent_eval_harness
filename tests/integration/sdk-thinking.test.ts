import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, object, type AttemptSpec } from "@eval/contracts";
import { body, listen } from "@eval/runtime/http";
import { piBackend } from "@eval/runtime/pi";
import { fakeIdentity } from "../fixtures/comparison.js";

for (const api of ["openai-completions", "openai-responses"] as const)
  for (const thinking of ["low", "max"] as const)
    test(`pi: ${api} sends the explicitly configured ${thinking} reasoning effort`, { timeout: 30000 }, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "sdk-max-thinking-"));
      const requests: Record<string, unknown>[] = [];
      const gateway = await listen(async (request, response) => {
        requests.push(object(await body(request)));
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (api === "openai-completions") {
          response.end([
            { id: "completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
            { id: "completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
          ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
        } else {
          const message = { type: "message", id: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "done", annotations: [] }] };
          const events = [
            { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
            { type: "response.output_item.done", output_index: 0, item: message },
            { type: "response.completed", response: { id: "response", status: "completed", output: [message],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ];
          response.end(events.map((event, sequence_number) =>
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
        }
      });
      const key = "SDK_MAX_THINKING_TEST_KEY", previous = process.env[key], previousOffline = process.env.PI_OFFLINE;
      process.env[key] = "local-fixture-secret";
      process.env.PI_OFFLINE = "1";
      try {
        const identity = { ...fakeIdentity, engine: "pi" as const };
        const spec: AttemptSpec = {
          runId: "max-thinking", taskId: "task", attemptId: "attempt", inputRevision: 1,
          engine: identity, evidenceBank: [], inputs: [], policy: DEFAULT_POLICY,
          evaluation: { id: "fixture", profile: "default", systemPrompt: "Follow the supplied evaluation contract.", outputSchema: { type: "object" },
            toolNames: [], fileSubmission: false, toolDescriptions: {}, submissionNudge: "Submit." },
          model: { provider: "evaluation-gateway", baseUrl: gateway.url + "/v1", api, apiKeyEnv: key,
            model: "deepseek-v4.1-flash", thinking, supportsDeveloperRole: false, contextWindow: 10000, maxOutputTokens: 1000 },
          prompt: "Respond with done.", hostUrl: gateway.url, deadline: Date.now() + 15000,
        };
        const errors: string[] = [];
        const session = await piBackend(identity).createSession({
          spec, workdir: directory, tools: [], async execute() { throw new Error("No tools are registered"); },
          onEvent(event) {
            const value = object(event);
            if (value.type !== "message_end") return;
            const message = object(value.message);
            if (message.stopReason === "error") errors.push(String(message.errorMessage));
          },
        });
        try { await session.run(spec.prompt); } finally { await session.dispose(); }
        assert.deepEqual(errors, []);
        assert.equal(requests.length, 1);
        assert.equal(api === "openai-completions" ? requests[0]!.reasoning_effort : object(requests[0]!.reasoning).effort, thinking,
          "the SDK must send the configured effort without silently changing it");
        const messages = (api === "openai-completions" ? requests[0]!.messages : requests[0]!.input) as Record<string, unknown>[];
        assert(!messages.some(message => message.role === "developer"));
        assert(messages.some(message => message.role === "system" && JSON.stringify(message.content).includes(spec.evaluation.systemPrompt)),
          "an endpoint without developer-role support must receive the evaluation contract as system");
      } finally {
        if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
        if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
        await gateway.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
