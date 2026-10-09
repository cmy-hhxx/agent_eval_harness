import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { object, type AgentProfile, type RunState, type WorkerEvent } from "@eval/contracts";
import { createRunRepository } from "@eval/data";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { createModelResolver } from "@eval/host-app/config";
import { body, listen } from "@eval/runtime/http";
import { piBackend } from "@eval/runtime/pi";
import { primeBackend } from "@eval/runtime/prime";
import { startWorker } from "@eval/runtime/worker";
import { fakeIdentity, fixtureConfig } from "../fixtures/comparison.js";
import { services } from "../fixtures/services.js";

/** Real SDK strict parsing followed by a same-session Runtime repair, with no external gateway. */
for (const engine of ["pi", "prime"] as const)
  for (const truncated of [false,true])
  test(`${engine}: ${truncated ? "incomplete tool arguments retain length" : "malformed completed tool arguments use the loading repair budget"} before a valid submission`, { timeout: 60000 }, async () => {
    const { directory, config, models } = await fixtureConfig();
    const inputId = randomUUID(), taskId = "malformed-task", runId = "malformed-sdk";
    const errors: string[] = [];
    let requests = 0;
    const gateway = await listen(async (req, res) => {
      try {
        const payload = object(await body(req));
        requests++;
        assert(requests <= 2, "the second submission ends the actual SDK session");
        if (requests === 2) {
          const encoded = JSON.stringify(payload.input);
          assert.equal(encoded.includes('tool_arguments_invalid'),!truncated,
            "only completed malformed calls use argument repair feedback");
          assert.equal(encoded.includes('argument_object_available'),!truncated);
        }
        const call = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`,
          name: "submit_evaluation", arguments: requests === 1 ? '{"ok":' : '{"ok":true}' };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
          { type: "response.output_item.done", output_index: 0, item: call },
          { type: truncated && requests === 1 ? "response.incomplete" : "response.completed", response: {
            id: `resp_${requests}`, status: truncated && requests === 1 ? "incomplete" : "completed",
            incomplete_details: truncated && requests === 1 ? { reason: "max_output_tokens" } : null, output: [call],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
        ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
      } catch (error) {
        errors.push(String(error)); res.writeHead(500); res.end(String(error));
      }
    });
    const profile: AgentProfile = {
      id: "default", systemPrompt: "Submit a complete JSON object.", instructions: "Submit JSON.", submissionNudge: "Submit JSON.",
      toolNames: [], fileSubmission: false, toolDescriptions: { submit_evaluation: "Submit the complete JSON object." },
      renderPrompt: () => "Submit {ok:true}.", requestSchema: { type: "object" },
      submissionSchema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { const: true } } },
    };
    const repository = createRunRepository<RunState>({ encode: state => structuredClone(state), references: () => [],
      resultId: row => String(row.id), decode: state => state },
    (task, state) => ({ id: task.id, file: "results.jsonl", row: { id: task.id, result: state.receipts[task.id].evaluation } }));
    const previous = process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway, previousOffline = process.env.PI_OFFLINE;
    process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway = "local-fixture-secret"; process.env.PI_OFFLINE = "1";
    const backend = (engine === "pi" ? piBackend : primeBackend)({ ...fakeIdentity, engine });
    const worker = await startWorker(backend,path.join(directory,"worker"));
    try {
      models.models.judge!.baseUrl = gateway.url + "/v1"; models.models.judge!.api = "openai-responses";
      const modelForStage = createModelResolver(models);
      await runEvaluation({ runId, debug: true, output: config.output, config,
        plan: { tasks: [{ id: taskId, stage: "malformed", inputIds: { answer: inputId }, dependencies: {}, data: {} }],
          inputs: { [inputId]: { messages: [{ content: "Original fixture material." }] } }, summary: {} },
        engine, identity: backend.identity, evaluatorVersion: "fixture", modelForStage: () => modelForStage("attribution"),
        policy: { ...config.execution, repairAttempts: 3 }, concurrency: 1, retries: 0, retryDelaySeconds: 0,
        agents: new AgentRegistry([{ id: "malformed", profiles: { default: profile } }]), repository,
        taskSource: { id: "malformed", bind: (task, inputs) => ({ agent: "malformed", profile: "default",
          request: { input: {}, sources: { answer: { id: task.inputIds.answer, value: inputs[task.inputIds.answer] } } } }) },
        workerUrls: [worker.url], runtime: services.runtime });
      assert.deepEqual(errors,[]); assert.equal(requests,2);
      const saved = await repository.readRun(path.join(config.output.path,runId));
      assert.equal(saved.manifest.states[taskId].attempts,1,"parameter repair does not use a transport attempt");
      assert.deepEqual(saved.receipts[taskId]?.evaluation,{ok:true});
      assert.deepEqual(saved.receipts[taskId]?.submissionStats,{contentSubmissions:1,fileErrors:truncated ? 0 : 1});
      const file = path.join(config.output.path,runId,"_internal/tasks",taskId,"attempt-001/events.jsonl.gz");
      const events = gunzipSync(await readFile(file)).toString().trim().split("\n").map(line=>JSON.parse(line) as WorkerEvent);
      const providerArguments = events.filter(event => event.type === "model" && object(event.data).type === "provider_tool_arguments")
        .map(event => event.data);
      assert.deepEqual(providerArguments, engine === "pi" ? [1, 2].map(index => ({ type: "provider_tool_arguments",
        response_id: `resp_${index}`, status: truncated && index === 1 ? "incomplete" : "completed",
        calls: [{ id: `fc_${index}`, call_id: `call_${index}`, name: "submit_evaluation",
          arguments: index === 1 ? '{"ok":' : '{"ok":true}' }] })) : []);
      const starts = events.filter(event=>event.type==="tool_start").map(event=>event.data as Record<string,unknown>);
      assert.equal(starts.length,truncated ? 1 : 2);
      if (!truncated) {
        assert.equal(starts[0].malformed_arguments,true); assert.equal(starts[0].argument_object_available,false);
        assert(!Object.hasOwn(starts[0],"args"),"strict SDK rejection never dispatches a replacement object");
      }
      assert.deepEqual(starts.at(-1)!.args,{ok:true});
    } finally {
      if (previous === undefined) delete process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway; else process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway=previous;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE=previousOffline;
      await worker.close(); await gateway.close(); await rm(directory,{recursive:true,force:true});
    }
  });
