import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { object, projectEvidenceReferences, ValidationError, type AgentProfile, type RunState, type AgentRequest, type TaskAnalysis } from "@eval/contracts";
import { cite, displayEvidence, evidenceSources } from "@eval/tools";
import { attributionFindingBasis, attributionProfile, type AttributionResult } from "@eval/agents/attribution";
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
        renderPrompt: () => `Already displayed source: ${material}. Read the source and submit a score.`, requestSchema: { type: "object" },
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
          if (requests === 3 + Number(mandatory)) {
            assert.match(JSON.stringify(payload.input), /draft_output_required/);
            assert(!JSON.stringify(payload.input).includes("AssertionError: read-only code"));
          }
          if (requests === 4 + Number(mandatory))
            assert.match(JSON.stringify(payload.input), /FileNotFoundError/,
              "the actual failed writer returns its script error before the same SDK gets one correction credit");
          if (requests === 8 + Number(mandatory)) {
            const last = (payload.input as Record<string, unknown>[]).findLast(item => item.type === "function_call_output");
            assert(String(last?.output).includes('"new_source_chars":0'), "initial display ranges reach both SDK tool loops");
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
            return { agent: "budget", profile: "default",
              presentedReads: [{ candidate: "answer", message_index: 0, kind: "text", path: "/content", start: 0, end: material.length }],
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

// A schema-valid unknown norm cannot establish compliance; final delivery is explicitly selected.
// File submission and its reserved writer remain available after repair exploration is exhausted.
for (const engine of ["pi", "prime"] as const)
    test(`${engine}: Responses file profile repairs an unknown basis selector after exploration is exhausted`,
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
        const fileProfile={...attributionProfile,draftWriteInCallLimit:false};
        const registry = new AgentRegistry([{ id: "attribution", profiles: { default: fileProfile } }]);
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
        result.findings[0].context_evidence = [structuredClone(normProof)];
        const draft = draftFor(prepared, result) as {
          strengths: { text: string; basis_index: number | null; evidence_status: string;
            evidence_indices: number[] }[];
        };
        const findingIndex = draft.strengths.findIndex(finding => finding.text === "遵守结论优先与 Markdown 规范。");
        assert(findingIndex >= 0, "the current fixture helper keeps the observation in the fixed strengths collection");
        const basisIndex = draft.strengths[findingIndex]!.basis_index;
        assert.equal(typeof basisIndex, "number", "the fixture helper selects the exact program-owned norm");
        assert(attributionFindingBasis(request.input).some(item => item.basis_index === basisIndex && item.kind === "own_rule"));
        const finalEvidenceIndex = prepared.evidenceBank.indexOf(finalProof.evidence_id) + 1;
        assert(finalEvidenceIndex > 0, "the final delivery is registered in the current evidence bank");
        draft.strengths[findingIndex]!.evidence_indices = [finalEvidenceIndex];
        const validDraft = structuredClone(draft);
        const valid = registry.resolve(binding, validDraft, { ...emptyAudit(), evidenceBank: [...prepared.evidenceBank] }) as AttributionResult;
        registry.validate(binding, valid, { ...emptyAudit(), evidenceBank: [...prepared.evidenceBank] });
        assert.deepEqual(valid.findings[findingIndex]!.evidence, [finalProof],
          "delivery evidence contains only the explicitly selected final answer");
        assert.deepEqual(valid.findings[findingIndex]!.context_evidence, [normProof],
          "the selected own-rule basis retains its complete norm separately");
        assert.equal(draft.strengths[findingIndex]!.evidence_status, "established");
        draft.strengths[findingIndex]!.basis_index = 99999;
        assert.throws(() => registry.resolve(binding, draft, { ...emptyAudit(), evidenceBank: [...prepared.evidenceBank] }),
          (error: unknown) => error instanceof ValidationError && error.issues!.some(issue =>
            issue.code === "finding_basis_invalid" && issue.path === `/strengths/${findingIndex}/basis_index`) &&
            error.issues!.every(issue => issue.path === `/strengths/${findingIndex}/basis_index`),
          "a nonexistent directory entry is rejected without changing the submitted judgment");
        const submissions = ["submit_evaluation_file"];
        const allTools = [...attributionProfile.toolNames, ...submissions];
        const writeDraft = (value: unknown) => ({ path: "evaluation.json", set_json: JSON.stringify(value) });
        const frames = (payload: Record<string, unknown>) => {
          const outputs = (payload.input as Record<string, unknown>[]).filter(item => item.type === "function_call_output").map(item => String(item.output));
          return outputs.flatMap(output => output.split("\n").flatMap(line => {
            try { return [object(JSON.parse(line))]; } catch { return []; }
          }));
        };
        const gatewayErrors: string[] = [];
        let requests = 0;
        const gateway = await listen(async (req, res) => {
          try {
            const payload = object(await body(req)), current = ++requests;
            assert(current <= 9, "two real file writes, two content submissions, and four exploration calls terminate the loop");
            const definitions = payload.tools as Record<string, unknown>[];
            const names = definitions.map(tool => tool.name);
            const history = frames(payload), budget = object(history.filter(frame => frame.budget).at(-1)?.budget ?? {});
            const contentFeedback = history.filter(frame => Array.isArray(frame.errors) && frame.budget &&
              Object.hasOwn(object(frame.budget), "content_remaining"));
            assert.deepEqual(names, current === 7 ? ["execute_code", "edit_json", ...submissions]
              : current >= 8 ? submissions : allTools,
              `request ${current}: file submission and protected draft writes follow their independent budgets`);
            assert(!names.includes("submit_evaluation"), "built-in attribution never exposes direct nested JSON arguments");
            const fileTool = definitions.find(tool => tool.name === "submit_evaluation_file")!;
            const scalarSchema = object(fileTool.parameters);
            assert.equal(scalarSchema.additionalProperties, false);
            assert.deepEqual(scalarSchema.required, ["path"]);
            assert.deepEqual(scalarSchema.properties, { path: { type: "string", minLength: 1 } });
            const description = String(fileTool.description);
            const contentSchema = object(JSON.parse(description.slice(description.indexOf('\n{"file_content_schema":') + 1)).file_content_schema);
            assert.equal(object(object(object(contentSchema.properties).strengths).items).type, "object");
            if (current === 3) {
              const errors = history.flatMap(frame => Array.isArray(frame.errors) ? frame.errors : []);
              assert(errors.some(value => object(value).code === "finding_basis_invalid" &&
                object(value).path === `/strengths/${findingIndex}/basis_index`));
              assert.equal(budget.content_remaining, 3, "one rejected file consumes one of the four submissions allowed by three repairs");
              assert.equal(object(budget.exploration).remaining, 4);
            }
            if (current === 5) {
              const read = history.find(frame => frame.selection_path === "/content" && Array.isArray(frame.evidence));
              const evidence = (read?.evidence as { quote: string; reference: { evidence_index: number } }[] | undefined)?.[0];
              assert.equal(evidence?.quote, final.text);
            }
            if (current >= 7) {
              assert.equal(object(budget.exploration).used, 5, "the initial writer and four repair exploration calls are charged");
              assert.equal(object(budget.exploration).remaining, 0);
              assert.deepEqual(budget.draft_writes, { used: current === 7 ? 0 : 1,
                remaining: current === 7 ? 1 : 0, tools: ["execute_code", "edit_json"] });
              assert.equal(contentFeedback.length, 1, "exploration adds no content rejection or repair");
              assert.equal(object(contentFeedback[0]!.budget).content_remaining, 3,
                "content feedback retains the cumulative ledger independently of exploration-only budget frames");
            }
            if (current === 9) assert(history.some(frame => frame.message && /预算|额度/.test(String(frame.message))),
              "an exhausted code call is rejected without creating writer credit");
            let name: string, args: Record<string, unknown>;
            if (current === 1) {
              name = "edit_json"; args = writeDraft(draft);
            } else if (current === 2) {
              name = "submit_evaluation_file"; args = { path: "evaluation.json" };
            } else if (current === 3 || current === 5) {
              name = "search_trace"; args = { candidate: "answer", query: current === 3 ? final.text : "=4" };
            } else if (current === 4) {
              name = "read_trace"; args = { candidate: "answer", message_index: 2, path: "/content" };
            } else if (current === 6) {
              name = "calculate"; args = { operation: "add", operands: ["2", "2"] };
            } else if (current === 7) {
              name = "edit_json"; args = writeDraft(validDraft);
            } else if (current === 8) {
              name = "execute_code"; args = { language: "python", code: "raise RuntimeError('exhausted code call must never execute')" };
            } else {
              name = "submit_evaluation_file"; args = { path: "evaluation.json" };
            }
            const id = `file-${current}`;
            res.writeHead(200, { "content-type": "text/event-stream" });
            const call = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args) };
            res.end([
              { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
              { type: "response.output_item.done", output_index: 0, item: call },
              { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [call],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
            ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
          } catch (error) {
            gatewayErrors.push(String(error)); res.writeHead(500); res.end(String(error));
          }
        });
        const repository = createRunRepository<RunState>({
          encode: state => structuredClone(state), references: () => [], resultId: row => String(row.id), decode: state => state,
        }, (task, state) => ({ id: task.id, file: "results.jsonl", row: { id: task.id, result: state.receipts[task.id].evaluation } }));
        const previous = process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway, previousOffline = process.env.PI_OFFLINE;
        process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway = "local-fixture-secret"; process.env.PI_OFFLINE = "1";
        const backend = (engine === "pi" ? piBackend : primeBackend)({ ...fakeIdentity, engine });
        const worker = await startWorker(backend, path.join(directory, "worker"));
        try {
          models.models.judge!.baseUrl = gateway.url + "/v1";
          const modelForStage = createModelResolver(models), runId = `evidence-repair-${engine}`;
          await runEvaluation({
            runId, output: config.output, config, plan: { tasks: [{ id: "final-evidence-repair", stage: "attribution",
              inputIds: { answer: request.sources.answer.id }, dependencies: {}, data: {} }],
            inputs: { [request.sources.answer.id]: request.sources.answer.value }, summary: {} },
            engine, identity: backend.identity, evaluatorVersion: "fixture", modelForStage: () => modelForStage("attribution"),
            policy: { ...config.execution, maxToolCalls: 2, repairAttempts: 3 }, concurrency: 1, retries: 0, retryDelaySeconds: 0,
            agents: registry, repository,
            taskSource: { id: "final-evidence-repair", bind: () => binding },
            workerUrls: [worker.url], runtime: services.runtime,
          });
          assert.deepEqual(gatewayErrors, []);
          assert.equal(requests, 9);
          const saved = await repository.readRun(path.join(config.output.path, runId)), receipt = saved.receipts["final-evidence-repair"];
          assert.equal(saved.manifest.states["final-evidence-repair"].attempts, 1);
          assert.deepEqual(receipt?.submissionStats, { contentSubmissions: 2, fileErrors: 0 });
          assert.equal(receipt?.audit.calls, 6, "two real draft writes, three source reads, and one calculation execute; the exhausted extra writer does not run");
          assert.equal(receipt?.audit.requiredReadCalls, 0);
          const textRead = { candidate: "answer", message_index: 2, kind: "text", path: "/content", start: 0, end: final.text.length };
          assert.deepEqual(receipt?.audit.traceReads, [textRead, textRead],
            "searches retain original text coordinates; JSON mirrors and already-read responses add no coverage");
          const accepted = receipt!.evaluation as AttributionResult;
          const acceptedFinding = accepted.findings.find(finding => finding.text === "遵守结论优先与 Markdown 规范。")!;
          assert.deepEqual(acceptedFinding.evidence, [finalProof]);
          assert.deepEqual(acceptedFinding.context_evidence, [normProof]);
        } finally {
          if (previous === undefined) delete process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway; else process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway = previous;
          if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
          await worker.close(); await gateway.close(); await rm(directory, { recursive: true, force: true });
        }
      });
