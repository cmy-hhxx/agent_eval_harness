import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { object, type AgentProfile, type RunState } from "@eval/contracts";
import { evidenceSources } from "@eval/tools";
import { createRunRepository } from "@eval/data";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { createModelResolver } from "@eval/host-app/config";
import { body, listen } from "@eval/runtime/http";
import { piBackend } from "@eval/runtime/pi";
import { startWorker } from "@eval/runtime/worker";
import { fakeIdentity, fixtureConfig } from "../fixtures/comparison.js";
import { services } from "../fixtures/services.js";

for (const materialKind of ["none", "text", "json"] as const)
    test(`pi: exhausted exploration permits failed-writer correction and mandatory reads; content repairs share the writer cap (${materialKind})`, { timeout: 60000 }, async () => {
      const { directory, config, models } = await fixtureConfig();
      const mandatory = materialKind !== "none";
      const material = "必须核对的原文。";
      const inputMessage = materialKind === "json" ? { output: { asset: "GLD.P", price: 369, note: material } } : { content: material };
      const source = evidenceSources(inputMessage).find(source => source.kind === (materialKind === "json" ? "json" : "text"))!;
      const readTarget = { candidate: "answer", message_index: 0, kind: source.kind, path: source.path, start: 0, end: source.text.length };
      const inputId = randomUUID();
      const submissionNames = ["submit_evaluation_file"];
      const ordinaryNames = ["read_trace", "search_trace", "calculate", "execute_code"];
      const allNames = [...ordinaryNames, ...submissionNames];
      const calculate = { name: "calculate", args: { operation: "add", operands: ["2", "2"] } };
      const read = { name: "read_trace", args: { candidate: "answer", message_index: 0, path: source.path, ...(materialKind === "json" ? {max_chars:source.text.length} : {}) } };
      const writeScore = (score: string | number) => ({ name: "execute_code", args: { language: "python",
        code: `from pathlib import Path\nPath('evaluation.json').write_text(${JSON.stringify(JSON.stringify({ score }))}, encoding='utf-8')`, outputs: ["evaluation.json"] } });
      const steps = [
        { ...calculate, tools: allNames },
        ...(mandatory ? [{ ...read, tools: ["read_trace", "execute_code", ...submissionNames] }] : []),
        { name: "execute_code", args: { language: "python", code: "raise AssertionError('read-only code must not execute in the reserved draft slot')" }, tools: ["execute_code", ...submissionNames] },
        { name: "execute_code", args: { language: "python", code: `from pathlib import Path\nPath(${JSON.stringify(path.join(directory, "wrong-run/evaluation.json"))}).write_text('unused')`,
          outputs: ["evaluation.json"] }, tools: ["execute_code", ...submissionNames] },
        { name: "submit_evaluation_file", args: { path: "missing.json" }, tools: ["execute_code", ...submissionNames] },
        { ...writeScore("bad"), tools: ["execute_code", ...submissionNames] },
        { name: "submit_evaluation_file", args: { path: "evaluation.json" }, tools: submissionNames },
        { name: "search_trace", args: { candidate: "answer", query: material }, tools: allNames },
        { ...read, tools: allNames },
        { ...calculate, tools: allNames },
        { ...writeScore(7), tools: ["execute_code", ...submissionNames] },
        { name: "submit_evaluation_file", args: { path: "evaluation.json" }, tools: submissionNames },
      ];
      const profile: AgentProfile = {
        id: "default", systemPrompt: "Evaluate the source JSON.", instructions: "Submit JSON.", submissionNudge: "Submit JSON.",
        toolNames: ordinaryNames, fileSubmission: true,
        toolDescriptions: { read_trace: "Read original source.", search_trace: "Locate original source.", calculate: "Calculate exactly.",
          execute_code: "Write the JSON file.", submit_evaluation_file: "Submit a JSON file." },
        renderPrompt: () => `Already displayed source: ${source.text}. Read the source and submit a score.`, requestSchema: { type: "object" },
        submissionSchema: { type: "object", additionalProperties: false, required: ["score"], properties: { score: { type: "number" } } },
        requiredReads: () => mandatory ? [readTarget] : [],
      };
      const gatewayErrors: string[] = [];
      let requests = 0;
      const gateway = await listen(async (req, res) => {
        try {
          const payload = object(await body(req)), step = steps[requests++];
          assert(step, "submission terminates without another model request");
          const tools = payload.tools as Record<string, unknown>[];
          assert.deepEqual(tools.map((tool) => tool.name), step.tools,
            `request ${requests}: actual budget and mandatory coverage determine the available tools`);
          if (requests === 3 + Number(mandatory)) {
            assert.match(JSON.stringify(payload.input), /draft_output_required/);
            assert(!JSON.stringify(payload.input).includes("AssertionError: read-only code"));
          }
          if (requests === 4 + Number(mandatory))
            assert.match(JSON.stringify(payload.input), /FileNotFoundError/,
              "the actual failed writer returns its script error before the same SDK gets one correction credit");
          if (requests === 8 + Number(mandatory)) {
            const last = (payload.input as Record<string, unknown>[]).findLast(item => item.type === "function_call_output");
            if (materialKind === "json") assert(String(last?.output).includes("/output/note"), "JSON mandatory reading retains navigation to its original text leaf");
            else assert(String(last?.output).includes('"new_source_chars":0'), "initial display ranges reach both SDK tool loops");
          }
          assert(!tools.some(tool => tool.name === "submit_evaluation"));
          const fileTool = tools.find(tool => tool.name === "submit_evaluation_file")!;
          const description = String(fileTool.description);
          const submission = object(JSON.parse(description.slice(description.indexOf('\n{"file_content_schema":') + 1)).file_content_schema);
          assert.equal(submission.additionalProperties, false);
          assert.deepEqual(submission.required, ["score"]);
          assert.deepEqual(object(submission.properties).score, { type: "number" });
          const call = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`, name: step.name, arguments: JSON.stringify(step.args) };
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end([
            { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
            { type: "response.output_item.done", output_index: 0, item: call },
            { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [call],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
          ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
        } catch (error) {
          gatewayErrors.push(String(error));
          res.writeHead(500);
          res.end(String(error));
        }
      });
      const repository = createRunRepository<RunState>({
        encode: (state) => structuredClone(state), references: () => [], resultId: (row) => String(row.id), decode: (state) => state,
      }, (task, state) => ({ id: task.id, file: "results.jsonl", row: { id: task.id, result: state.receipts[task.id].evaluation } }));
      const previous = process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway, previousOffline = process.env.PI_OFFLINE;
      process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway = "local-fixture-secret";
      process.env.PI_OFFLINE = "1";
      const backend = piBackend({ ...fakeIdentity, engine: "pi" });
      const worker = await startWorker(backend, path.join(directory, "worker"));
      try {
        models.models.judge!.baseUrl = gateway.url + "/v1";
        models.models.judge!.api = "openai-responses";
        const modelForStage = createModelResolver(models), runId = `budget-pi-${materialKind}`;
        await runEvaluation({
          runId, output: config.output, config, plan: { tasks: [{ id: "budget-task", stage: "budget", inputIds: { answer: inputId }, dependencies: {}, data: {} }],
            inputs: { [inputId]: { messages: [inputMessage] } }, summary: {} },
          engine: "pi", identity: backend.identity, evaluatorVersion: "fixture", modelForStage: () => modelForStage("attribution"),
          policy: { ...config.execution, maxToolCalls: 1, repairAttempts: 2 }, concurrency: 1, retries: 0, retryDelaySeconds: 0,
          agents: new AgentRegistry([{ id: "budget", profiles: { default: profile } }]), repository,
          taskSource: { id: "budget", bind: (task, inputs) => {
            const id = task.inputIds.answer;
            return { agent: "budget", profile: "default",
              presentedReads: [readTarget],
              request: { input: {}, sources: {
              answer: { id, value: inputs[id] },
            } } };
          } },
          workerUrls: [worker.url],
          runtime: services.runtime,
        });
        assert.deepEqual(gatewayErrors, []);
        assert.equal(requests, steps.length);
        const saved = await repository.readRun(path.join(config.output.path, runId));
        assert.equal(saved.manifest.states["budget-task"].attempts, 1);
        assert.equal(saved.manifest.states["budget-task"].status, "succeeded", JSON.stringify(saved.manifest.states["budget-task"]));
        const receipt = saved.receipts["budget-task"];
        assert.deepEqual(receipt?.evaluation, { score: 7 });
        assert.deepEqual(receipt?.submissionStats, { contentSubmissions: 2, fileErrors: 1 });
        assert.equal(receipt?.audit.calls, 7 + Number(mandatory), "all three protected writer attempts count within the default cap");
        assert.equal(receipt?.audit.requiredReadCalls, Number(mandatory));
      } finally {
        if (previous === undefined) delete process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway;
        else process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway = previous;
        if (previousOffline === undefined) delete process.env.PI_OFFLINE;
        else process.env.PI_OFFLINE = previousOffline;
        await worker.close();
        await gateway.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
