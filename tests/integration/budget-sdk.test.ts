import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { object, projectEvidenceReferences, ValidationError, type AgentProfile, type RunState, type AgentRequest, type TaskAnalysis } from "@eval/contracts";
import { cite, displayEvidence, evidenceSources } from "@eval/tools";
import { attributionProfile, type AttributionResult } from "@eval/agents/attribution";
import { createRunRepository } from "@eval/data";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { createModelResolver } from "@eval/host-app/config";
import { body, listen } from "@eval/runtime/http";
import { piBackend } from "@eval/runtime/pi";
import { primeBackend } from "@eval/runtime/prime";
import { startWorker } from "@eval/runtime/worker";
import example from "../../packages/agents/src/attribution/fixtures/example.json" with { type: "json" };
import { draftFor, emptyAudit, fakeIdentity, fixtureConfig, taskResult } from "../fixtures/comparison.js";
import { setFixtureNormDirectory } from "../fixtures/attribution-submission.js";
import { services } from "../fixtures/services.js";

for (const engine of ["pi", "prime"] as const)
  for (const mandatory of [false, true])
    test(`${engine}: exhausted exploration permits failed-writer correction and mandatory reads; content repairs share the writer cap (${mandatory})`, { timeout: 60000 }, async () => {
      const { directory, config, models } = await fixtureConfig();
      const material = "必须核对的原文。";
      const inputId = randomUUID();
      const submissionNames = ["submit_evaluation_file"];
      const ordinaryNames = ["read_trace", "search_trace", "calculate", "execute_code"];
      const allNames = [...ordinaryNames, ...submissionNames];
      const calculate = { name: "calculate", args: { operation: "add", operands: ["2", "2"] } };
      const read = { name: "read_trace", args: { candidate: "answer", message_index: 0, path: "/content" } };
      const writeScore = (score: string | number) => ({ name: "execute_code", args: { language: "python",
        code: `from pathlib import Path\nPath('evaluation.json').write_text(${JSON.stringify(JSON.stringify({ score }))}, encoding='utf-8')` } });
      const steps = [
        { ...calculate, tools: allNames },
        ...(mandatory ? [{ ...read, tools: ["read_trace", "execute_code", ...submissionNames] }] : []),
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
        renderPrompt: () => "Read the source and submit a score.", requestSchema: { type: "object" },
        submissionSchema: { type: "object", additionalProperties: false, required: ["score"], properties: { score: { type: "number" } } },
        requiredReads: () => mandatory ? [{ candidate: "answer", message_index: 0, kind: "text", path: "/content", start: 0, end: material.length }] : [],
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
          if (requests === 3 + Number(mandatory))
            assert.match(JSON.stringify(payload.input), /FileNotFoundError/,
              "the actual failed writer returns its script error before the same SDK gets one correction credit");
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
      const previous = process.env.EVAL_API_KEY, previousOffline = process.env.PI_OFFLINE;
      process.env.EVAL_API_KEY = "local-fixture-secret";
      process.env.PI_OFFLINE = "1";
      const backend = (engine === "pi" ? piBackend : primeBackend)({ ...fakeIdentity, engine });
      const worker = await startWorker(backend, path.join(directory, "worker"));
      try {
        models.models.judge!.baseUrl = gateway.url + "/v1";
        models.models.judge!.api = "openai-responses";
        const modelForStage = createModelResolver(models), runId = `budget-${engine}-${mandatory}`;
        await runEvaluation({
          runId, output: config.output, config, plan: { tasks: [{ id: "budget-task", stage: "budget", inputIds: { answer: inputId }, dependencies: {}, data: {} }],
            inputs: { [inputId]: { messages: [{ content: material }] } }, summary: {} },
          engine, identity: backend.identity, evaluatorVersion: "fixture", modelForStage: () => modelForStage("attribution"),
          policy: { ...config.execution, maxToolCalls: 1, repairAttempts: 2 }, concurrency: 1, retries: 0, retryDelaySeconds: 0,
          agents: new AgentRegistry([{ id: "budget", profiles: { default: profile } }]), repository,
          taskSource: { id: "budget", bind: (task, inputs) => {
            const id = task.inputIds.answer;
            return { agent: "budget", profile: "default", request: { input: {}, sources: {
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
        if (previous === undefined) delete process.env.EVAL_API_KEY;
        else process.env.EVAL_API_KEY = previous;
        if (previousOffline === undefined) delete process.env.PI_OFFLINE;
        else process.env.PI_OFFLINE = previousOffline;
        await worker.close();
        await gateway.close();
        await rm(directory, { recursive: true, force: true });
      }
    });

// A schema-valid unknown norm cannot establish compliance; the program binds known final delivery.
// Direct submission remains available after the repair exploration budget is exhausted.
for (const engine of ["pi", "prime"] as const)
  for (const api of ["openai-completions", "openai-responses"] as const)
    test(`${engine}: ${api} repairs an unknown norm selector directly after exploration is exhausted`,
      { timeout: 60000 }, async () => {
        const { directory, config, models } = await fixtureConfig();
        const norm = "结论优先：正文第一句明确判断，随后使用 Markdown 解释依据。";
        const request = structuredClone(example.request) as AgentRequest;
        const original = request.sources.answer.value as { messages: Record<string, unknown>[] };
        original.messages.splice(1, 0, { type: "message", role: "system", content: norm });
        Object.assign(request.input.answer as object, { final_message_index: 2 });
        const final = evidenceSources(original.messages[2]).find(leaf => leaf.kind === "text" && leaf.path === "/content")!;
        const finalProof = cite(request.sources.answer.id, 2, final, 0, final.text.length);
        const normSource = evidenceSources(original.messages[1]).find(leaf => leaf.kind === "text" && leaf.path === "/content")!;
        const normProof = cite(request.sources.answer.id, 1, normSource, 0, normSource.text.length);
        Object.assign(request.input.answer as object, { final_evidence: [finalProof] });
        const norms = setFixtureNormDirectory(request);
        const registry = new AgentRegistry([{ id: "attribution", profiles: { default: attributionProfile } }]);
        const analysis = request.input.task_analysis as unknown as TaskAnalysis;
        const modelAnalysis = { task_type: analysis.task_type, goal: analysis.goal,
          ...Object.fromEntries((["requirements", "scoring_points", "red_flags"] as const).map(kind => [kind,
            analysis[kind].flatMap((criterion, requirement_index) => {
              if (criterion.applies_to.length && !criterion.applies_to.includes(request.sources.answer.id)) return [];
              const { applies_to: _scope, acceptance_rule, ...rule } = criterion;
              return [{ ...rule, ...(acceptance_rule === criterion.text ? {} : { acceptance_rule }), applicable_candidates: ["answer"],
                ...(kind === "requirements" ? { requirement_index } : {}) }];
            })])) };
        const binding = { agent: "attribution", profile: "default", request, projectModelInput: projectEvidenceReferences,
          modelInput: { ...request.input, task_analysis: modelAnalysis, answer: { ...request.input.answer as object,
            final_evidence: [displayEvidence(finalProof)],
            norm_directory: norms.map(norm => ({ ...norm, evidence: norm.evidence.map(displayEvidence) })),
            instruction_sources: [{ message_index: 1, path: "/content", role: "system", content: norm,
              evidence: [displayEvidence(normProof)] }] } } };
        const prepared = { ...registry.prepare(binding), inputs: Object.entries(request.sources).map(([name, source]) => ({ name, id: source.id })) };
        const result = taskResult(prepared) as AttributionResult;
        result.correctness_evidence = [structuredClone(finalProof)];
        result.findings.forEach(finding => { finding.evidence = [structuredClone(finalProof)]; });
        Object.assign(result.findings[0], { dimension: "instruction_following", importance: "medium",
          text: "遵守结论优先与 Markdown 规范。", reason: "最终回答先给结论，再用 Markdown 表达依据。" });
        result.findings[0].assessment.requirement_index = null;
        result.findings[0].evidence = [structuredClone(normProof), structuredClone(finalProof)];
        const draft = draftFor(prepared, result) as {
          findings: { text: string; norm_index?: number | null; assessment: { evidence_status: string };
            evidence: { evidence_index: number }[] }[];
        };
        const findingIndex = draft.findings.findIndex(finding => finding.text === "遵守结论优先与 Markdown 规范。");
        assert(findingIndex >= 0, "the current fixture helper keeps the real finding in the single flat collection");
        const normIndex = draft.findings[findingIndex]!.norm_index;
        assert.equal(typeof normIndex, "number", "the fixture helper selects the exact program-owned norm");
        assert(norms.some(norm => norm.norm_index === normIndex && norm.requirement_index === null &&
          norm.evidence.some(evidence => evidence.evidence_id === normProof.evidence_id)));
        draft.findings[findingIndex]!.evidence = [];
        const validDraft = structuredClone(draft);
        const valid = registry.resolve(binding, validDraft, { ...emptyAudit(), evidenceBank: [...prepared.evidenceBank] }) as AttributionResult;
        registry.validate(binding, valid, { ...emptyAudit(), evidenceBank: [...prepared.evidenceBank] });
        assert.deepEqual(valid.findings[findingIndex]!.evidence, [normProof, finalProof],
          "the program binds the complete own norm and actual final delivery without model evidence copying");
        assert.equal(draft.findings[findingIndex]!.assessment.evidence_status, "established");
        draft.findings[findingIndex]!.norm_index = null;
        assert.throws(() => registry.resolve(binding, draft, { ...emptyAudit(), evidenceBank: [...prepared.evidenceBank] }),
          (error: unknown) => error instanceof ValidationError && error.issues!.length > 0 && error.issues!.every(issue =>
            issue.code === "finding_norm_unknown" && issue.path === `/findings/${findingIndex}/norm_index`),
          "the schema accepts null, but business validation requires uncertain for an unknown norm");
        const submissions = ["submit_evaluation"];
        const allTools = [...attributionProfile.toolNames, ...submissions];
        const frames = (payload: Record<string, unknown>) => {
          const outputs = api === "openai-completions"
            ? (payload.messages as Record<string, unknown>[]).filter(item => item.role === "tool").map(item => String(item.content))
            : (payload.input as Record<string, unknown>[]).filter(item => item.type === "function_call_output").map(item => String(item.output));
          return outputs.flatMap(output => output.split("\n").flatMap(line => {
            try { return [object(JSON.parse(line))]; } catch { return []; }
          }));
        };
        const gatewayErrors: string[] = [];
        let requests = 0;
        const gateway = await listen(async (req, res) => {
          try {
            const payload = object(await body(req)), current = ++requests;
            assert(current <= 7, "two content submissions and four repair exploration calls terminate the loop");
            const definitions = (payload.tools as Record<string, unknown>[]).map(tool =>
              api === "openai-completions" ? object(tool.function) : tool);
            const names = definitions.map(tool => tool.name);
            const history = frames(payload), budget = object(history.filter(frame => frame.budget).at(-1)?.budget ?? {});
            const contentFeedback = history.filter(frame => Array.isArray(frame.errors) && frame.budget &&
              Object.hasOwn(object(frame.budget), "content_remaining"));
            assert.deepEqual(names, current >= 6 ? submissions : allTools,
              `request ${current}: content submission remains available after exploration is exhausted`);
            if (current === 2) {
              const errors = history.flatMap(frame => Array.isArray(frame.errors) ? frame.errors : []);
              assert(errors.some(value => object(value).code === "finding_norm_unknown" &&
                object(value).path === `/findings/${findingIndex}/norm_index`));
              assert.equal(budget.content_remaining, 2, "the rejected content consumes one of the three total submissions");
              assert.equal(object(budget.exploration).remaining, 4);
            }
            if (current === 4) {
              const read = history.find(frame => frame.selection_path === "/content" && Array.isArray(frame.evidence));
              const evidence = (read?.evidence as { quote: string; reference: { evidence_index: number } }[] | undefined)?.[0];
              assert.equal(evidence?.quote, final.text);
            }
            if (current >= 6) {
              assert.equal(object(budget.exploration).used, 4);
              assert.equal(object(budget.exploration).remaining, 0);
              assert.deepEqual(budget.draft_writes, { used: 0, remaining: 0, tools: ["execute_code"] });
              assert.equal(contentFeedback.length, 1, "exploration adds no content rejection or repair");
              assert.equal(object(contentFeedback[0]!.budget).content_remaining, 2,
                "content feedback retains the cumulative ledger independently of exploration-only budget frames");
            }
            if (current === 7) assert(history.some(frame => frame.message && /预算|额度/.test(String(frame.message))),
              "an exhausted code call is rejected without creating writer credit");
            let name: string, args: Record<string, unknown>;
            if (current === 1) {
              name = "submit_evaluation"; args = structuredClone(draft);
            } else if (current === 2 || current === 4) {
              name = "search_trace"; args = { candidate: "answer", query: current === 2 ? final.text : "=4" };
            } else if (current === 3) {
              name = "read_trace"; args = { candidate: "answer", message_index: 2, path: "/content" };
            } else if (current === 5) {
              name = "calculate"; args = { operation: "add", operands: ["2", "2"] };
            } else if (current === 6) {
              name = "execute_code"; args = { language: "python", code: "raise RuntimeError('exhausted code call must never execute')" };
            } else {
              name = "submit_evaluation";
              args = structuredClone(validDraft);
            }
            const id = `direct-${current}`;
            res.writeHead(200, { "content-type": "text/event-stream" });
            if (api === "openai-completions") {
              const event = { id, object: "chat.completion.chunk", created: 1, model: "fixture" };
              res.end([
                { ...event, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${id}`,
                  type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
                { ...event, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
              ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
            } else {
              const call = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args) };
              res.end([
                { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
                { type: "response.output_item.done", output_index: 0, item: call },
                { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [call],
                  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
              ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
            }
          } catch (error) {
            gatewayErrors.push(String(error)); res.writeHead(500); res.end(String(error));
          }
        });
        const repository = createRunRepository<RunState>({
          encode: state => structuredClone(state), references: () => [], resultId: row => String(row.id), decode: state => state,
        }, (task, state) => ({ id: task.id, file: "results.jsonl", row: { id: task.id, result: state.receipts[task.id].evaluation } }));
        const previous = process.env.EVAL_API_KEY, previousOffline = process.env.PI_OFFLINE;
        process.env.EVAL_API_KEY = "local-fixture-secret"; process.env.PI_OFFLINE = "1";
        const backend = (engine === "pi" ? piBackend : primeBackend)({ ...fakeIdentity, engine });
        const worker = await startWorker(backend, path.join(directory, "worker"));
        try {
          models.models.judge!.baseUrl = gateway.url + "/v1";
          models.models.judge!.api = api;
          const modelForStage = createModelResolver(models), runId = `evidence-repair-${engine}-${api}`;
          await runEvaluation({
            runId, output: config.output, config, plan: { tasks: [{ id: "final-evidence-repair", stage: "attribution",
              inputIds: { answer: request.sources.answer.id }, dependencies: {}, data: {} }],
            inputs: { [request.sources.answer.id]: request.sources.answer.value }, summary: {} },
            engine, identity: backend.identity, evaluatorVersion: "fixture", modelForStage: () => modelForStage("attribution"),
            policy: { ...config.execution, maxToolCalls: 1, repairAttempts: 2 }, concurrency: 1, retries: 0, retryDelaySeconds: 0,
            agents: registry, repository,
            taskSource: { id: "final-evidence-repair", bind: () => binding },
            workerUrls: [worker.url], runtime: services.runtime,
          });
          assert.deepEqual(gatewayErrors, []);
          assert.equal(requests, 7);
          const saved = await repository.readRun(path.join(config.output.path, runId)), receipt = saved.receipts["final-evidence-repair"];
          assert.equal(saved.manifest.states["final-evidence-repair"].attempts, 1);
          assert.deepEqual(receipt?.submissionStats, { contentSubmissions: 2, fileErrors: 0 });
          assert.equal(receipt?.audit.calls, 4, "three source reads and one calculation execute; direct submissions do not use a writer");
          assert.equal(receipt?.audit.requiredReadCalls, 0);
          const textRead = { candidate: "answer", message_index: 2, kind: "text", path: "/content", start: 0, end: final.text.length };
          const jsonRead = { candidate: "answer", message_index: 2, kind: "json", path: "", start: 0,
            end: JSON.stringify(original.messages[2], null, 2).length };
          assert.deepEqual(receipt?.audit.traceReads, [textRead, jsonRead, textRead, textRead, jsonRead],
            "both searches and the explicit reader retain the original source ranges");
          const accepted = receipt!.evaluation as AttributionResult;
          assert.deepEqual(accepted.findings.find(finding => finding.text === "遵守结论优先与 Markdown 规范。")!.evidence,
            [normProof, finalProof]);
        } finally {
          if (previous === undefined) delete process.env.EVAL_API_KEY; else process.env.EVAL_API_KEY = previous;
          if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
          await worker.close(); await gateway.close(); await rm(directory, { recursive: true, force: true });
        }
      });
