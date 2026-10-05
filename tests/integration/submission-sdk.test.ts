import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { object, type AgentProfile, type RunState, type ValidationIssue } from "@eval/contracts";
import { createRunRepository } from "@eval/data";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { createModelResolver } from "@eval/host-app/config";
import { body, listen } from "@eval/runtime/http";
import { fixtureConfig } from "../fixtures/comparison.js";
import { services } from "../fixtures/services.js";

for (const engine of ["pi", "prime"] as const)
  for (const api of ["openai-completions", "openai-responses"] as const)
    test(`${engine}: ${api} submits original JSON to Host while ordinary tool parameters stay validated`, { timeout: 60000 }, async () => {
      const { directory, config, models } = await fixtureConfig();
      const invalid = { count: "7", enabled: "true", text: 9, note: null, satisfies: false };
      const valid = { count: 7, enabled: true, text: "nine", note: null, satisfies: true };
      const drafts: unknown[] = [], gatewayErrors: string[] = [];
      let requests = 0;
      const profile: AgentProfile = {
        id: "default", systemPrompt: "Evaluate the supplied JSON.", instructions: "Submit JSON.", submissionNudge: "Submit JSON.",
        toolNames: ["calculate"], fileSubmission: false,
        toolDescriptions: { calculate: "Calculate exactly.", submit_evaluation: "Submit the complete result." },
        renderPrompt: () => "Evaluate the supplied JSON and submit it.", requestSchema: { type: "object" },
        submissionSchema: {
          type: "object", additionalProperties: false, required: ["count", "enabled", "text", "note", "satisfies"],
          $defs: { count: { type: "number" } },
          properties: { count: { $ref: "#/$defs/count" }, enabled: { type: "boolean" }, text: { type: "string" },
            note: { type: ["string", "null"] }, satisfies: { type: "boolean" } },
        },
        validateSubmission(_request, draft) {
          drafts.push(structuredClone(draft));
          return draft && typeof draft === "object" && !Array.isArray(draft) && (draft as Record<string, unknown>).satisfies === false ? [
            { category: "decision", code: "requirement_unmet", path: "/satisfies", actual: false, message: "The requirement is unmet." },
          ] : [];
        },
      };
      const gateway = await listen(async (req, res) => {
        try {
          const payload = object(await body(req));
          assert(++requests <= 3, "invalid parameters and one content repair need only three model requests");
          const tools = payload.tools as Record<string, unknown>[];
          const definitions = tools.map((tool) => api === "openai-completions" ? object(tool.function) : tool);
          const schema = object(definitions.find((tool) => tool.name === "submit_evaluation")!.parameters);
          assert.equal(schema.additionalProperties, false);
          assert.deepEqual(schema.required, ["count", "enabled", "text", "note", "satisfies"]);
          assert.deepEqual(object(schema.properties).count, { type: "number" });
          assert(!/"(?:\$ref|\$defs)"\s*:/.test(JSON.stringify(schema)), "the model receives the full inlined submission schema");
          assert.deepEqual(object(object(definitions.find((tool) => tool.name === "calculate")!.parameters).properties).operation,
            { enum: ["add", "subtract", "multiply", "divide"] });
          const outputs = api === "openai-completions"
            ? (payload.messages as Record<string, unknown>[]).filter((message) => message.role === "tool").map((message) => String(message.content))
            : (payload.input as Record<string, unknown>[]).filter((item) => item.type === "function_call_output").map((item) => String(item.output));
          if (requests === 2) assert(outputs.some((output) => /Validation failed for tool "calculate"/.test(output)),
            "ordinary tool arguments still fail at the SDK parameter boundary");
          if (requests === 3) {
            const frames = (outputs.find((output) => output.includes('"schema_type"')) ?? "{}").split("\n");
            const feedback = JSON.parse(frames.find((frame) => frame.includes('"schema_type"')) ?? "{}") as {
              errors?: ValidationIssue[]; budget?: { content_remaining: number } };
            assert.deepEqual(feedback.errors?.map((issue) => [issue.code, issue.path, issue.actual]), [
              ["schema_type", "/count", "7"], ["schema_type", "/enabled", "true"], ["schema_type", "/text", 9],
              ["requirement_unmet", "/satisfies", false],
            ], "Host reports structure and independent decisions together, preserving original values");
            assert.equal(feedback.budget?.content_remaining, 2);
            const currentBudget = JSON.parse(frames.at(-1)!).budget;
            assert.equal(currentBudget.content_remaining, 2);
            assert.equal(currentBudget.exploration.remaining, 15);
            assert.equal(currentBudget.required_reads.covered, true);
          }
          const name = requests === 1 ? "calculate" : "submit_evaluation";
          const args = requests === 1 ? { operation: "invalid", operands: ["2", "2"] } : requests === 2 ? invalid : valid;
          const id = `fixture-${requests}`;
          res.writeHead(200, { "content-type": "text/event-stream" });
          if (api === "openai-completions") {
            const event = { id, object: "chat.completion.chunk", created: 1, model: "fixture" };
            res.end([
              { ...event, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${id}`,
                type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
              { ...event, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
            ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
          } else {
            const call = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args) };
            res.end([
              { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
              { type: "response.output_item.done", output_index: 0, item: call },
              { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [call],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
            ].map((event, sequence_number) =>
              `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
          }
        } catch (error) {
          gatewayErrors.push(String(error));
          res.writeHead(500);
          res.end(String(error));
        }
      });
      const repository = createRunRepository<RunState>({
        encode: (state) => structuredClone(state), references: () => [], resultId: (row) => String(row.id), decode: (state) => state,
      }, (task, state) => ({ id: task.id, file: "results.jsonl", row: { id: task.id, result: state.receipts[task.id].evaluation } }));
      const previous = process.env.EVAL_API_KEY;
      process.env.EVAL_API_KEY = "local-fixture-secret";
      try {
        models.models.judge!.baseUrl = gateway.url + "/v1";
        models.models.judge!.api = api;
        models.models.judge!.thinking = "off";
        const runId = `submission-${engine}-${api}`;
        const modelForStage = createModelResolver(models);
        await runEvaluation({
          runId, output: config.output, config, plan: { tasks: [{ id: "structured-task", stage: "structured", inputIds: {}, dependencies: {}, data: {} }], inputs: {}, summary: {} },
          engine, evaluatorVersion: "fixture", modelForStage: () => modelForStage("attribution"),
          policy: { ...config.execution, repairAttempts: 2 }, concurrency: 1, retries: 0, retryDelaySeconds: 0,
          agents: new AgentRegistry([{ id: "structured", profiles: { default: profile } }]), repository,
          taskSource: { id: "structured", bind: () => ({ agent: "structured", profile: "default", request: { input: {}, sources: {} } }) },
          runtime: services.runtime,
        });
        assert.deepEqual(gatewayErrors, []);
        assert.equal(requests, 3);
        assert.deepEqual(drafts, [invalid, valid], "SDK preserves string, number, boolean and null submission values");
        const saved = await repository.readRun(path.join(config.output.path, runId));
        assert.equal(saved.manifest.states["structured-task"].attempts, 1);
        const receipt = saved.receipts["structured-task"];
        assert.deepEqual(receipt?.evaluation, valid);
        assert.equal(receipt?.submissionStats?.contentSubmissions, 2);
        assert.equal(receipt?.audit.calls, 0, "the rejected ordinary call never enters the application tool runtime");
      } finally {
        if (previous === undefined) delete process.env.EVAL_API_KEY;
        else process.env.EVAL_API_KEY = previous;
        await gateway.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
