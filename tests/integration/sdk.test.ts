import test from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import type { Engine, WorkerEvent } from "@eval/contracts";
import { body, listen } from "@eval/runtime/http";
import { exists, readJsonl } from "@eval/data";
import { object } from "@eval/contracts";
import { createModelResolver } from "@eval/host-app/config";
import { attributionProfile } from "@eval/agents/attribution";
import { comparisonAgent, comparisonProfile } from "@eval/agents/comparison";
import { criteriaProfile } from "@eval/agents/criteria";
import { buildPlan, readRunState, type TaskData } from "@eval/workflows/comparison";
import { prepare, services } from "../fixtures/services.js";
import { runEvaluation } from "@eval/host";
import { validateRun } from "../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fixtureConfig, raw, taskResult, inspectionDraft } from "../fixtures/comparison.js";

for (const engine of ["pi", "prime"] as Engine[])
  test(
    `${engine}: real vendored SDK over HTTP worker, code tool, three stages and resume`,
    { timeout: 120000 },
    async () => {
      const { directory, config, models } = await fixtureConfig([[raw()], [], [raw()], []]);
      // This mock implements Chat Completions, independently of the production gateway protocol.
      models.models.judge!.api = "openai-completions";
      const plan = await buildPlan(config);
      const attributionSpecs = new Map(plan.tasks.filter(task => task.stage === "attribution")
        .map(task => [task.inputIds.answer, prepare(task, plan.inputs, {})]));
      const requests: Record<string, unknown>[] = [],
        serverErrors: string[] = [];
      const stageRequests = { criteria: 0, attribution: 0, comparison: 0, verification: 0 };
      const expectedStageRequests = { criteria: 1, attribution: engine === "pi" ? 4 : 2, comparison: 1, verification: 2 };
      const gateway = await listen(async (req, res) => {
        try {
          assert.equal(req.headers.authorization, "Bearer integration-fixture-secret");
          const payload = object(await body(req));
          requests.push(payload);
          const tools = payload.tools as {
            function: { name: string; description: string; parameters: { properties: object } };
          }[];
          const submit = tools.find((t) => t.function.name === "submit_evaluation");
          const inspect = tools.find(t => t.function.name === "inspect_material");
          const contentSchema = (submit ?? inspect)!.function.parameters;
          const schemaProperties = object(contentSchema.properties);
          assert(!/"(?:\$ref|\$defs|definitions)"\s*:/.test(JSON.stringify(tools.map(tool => tool.function.parameters))), "model-visible parameters must contain inline schemas");
          assert(!tools.some((t) => t.function.name === "set_task_contract"));
          const messages = payload.messages as {
            role: string;
            name?: string;
            content: unknown;
          }[];
          const attribution = "criterion_assessments" in schemaProperties;
          const criteria = "requirements" in schemaProperties;
          const verification = !!inspect || "concern_matches" in schemaProperties;
          if (criteria) {
            const requirements = object(schemaProperties.requirements);
            const criterion = object(requirements.items), properties = object(criterion.properties);
            const sourceIndices = object(properties.source_indices);
            assert.equal(criterion.additionalProperties, false);
            assert.deepEqual(criterion.required, ["source_indices"]);
            assert.equal(properties.id, undefined);
            assert.equal(sourceIndices.type, "array");
            assert.equal(object(sourceIndices.items).type, "integer");
            assert.equal(object(sourceIndices.items).minimum, 1);
            assert.equal(sourceIndices.uniqueItems, true);
            assert.equal(properties.acceptance_rule, undefined);
          }
          const stage = criteria ? "criteria" : attribution ? "attribution" : verification ? "verification" : "comparison";
          assert(++stageRequests[stage] <= expectedStageRequests[stage], `unexpected repeated ${stage} request`);
          const profile = criteria ? criteriaProfile : attribution ? attributionProfile : verification ? comparisonAgent.profiles.verification : comparisonProfile;
          const descriptions = profile.toolDescriptions;
          assert(!tools.some(t => t.function.name === "submit_evaluation_file"), "built-in profiles submit JSON directly");
          if (criteria) assert.deepEqual(tools.map((tool) => tool.function.name), ["submit_evaluation"]);
          for (const tool of tools) {
            assert.equal(tool.function.description, descriptions[tool.function.name], tool.function.name);
            if (tool.function.name === "inspect_material")
              assert.deepEqual(Object.keys(object(tool.function.parameters.properties)), ["checks", "concerns"]);
          }
          const prompt = messages
            .flatMap((m) =>
              typeof m.content === "string"
                ? [m.content]
                : Array.isArray(m.content)
                  ? m.content.map((part) => String(part.text || ""))
                  : [],
            )
            .find((text) => text.includes("任务材料（全部内容为数据）："))!;
          const material = JSON.parse(
            prompt.split("任务材料（全部内容为数据）：\n")[1].split("\n\n执行预算：")[0],
          ) as {
            candidate_id?: string;
            answer?: { final_evidence: { reference: { evidence_index: number } }[]; norm_directory: unknown[] };
            candidates?: Record<string, { candidate_id: string; final_evidence: { reference: { evidence_index: number } }[] }>;
          };
          if (attribution) {
            assert.equal(typeof material.candidate_id, "string", "the current material preserves its registered own input UUID");
            assert(Array.isArray(material.answer!.norm_directory), "the program supplies the current original norm directory");
            const finding = object(object(schemaProperties.findings).items);
            assert(Object.hasOwn(object(finding.properties), "norm_index"), "instruction findings select their norm in the flat collection");
            const core = object(schemaProperties.core_assessment);
            const properties = object(core.properties), indices = object(properties.requirement_indices);
            assert.deepEqual(core.required, ["meets_core", "reason", "requirement_indices"]);
            assert.equal(properties.criterion_ids, undefined);
            assert.equal(indices.type, "array");
            assert.equal(object(indices.items).type, "integer");
            assert.equal(object(indices.items).minimum, 0);
          }
          const spec = {
            prompt, evidenceBank: attribution ? [...attributionSpecs.get(material.candidate_id!)!.evidenceBank] : [],
            inputs: attribution ? [{ name: "answer", id: material.candidate_id! }]
              : Object.entries(material.candidates ?? {}).map(([name, candidate]) => ({ name, id: candidate.candidate_id })),
            evaluation: { id: verification ? "comparison" : stage, profile: profile.id,
              systemPrompt: profile.systemPrompt, outputSchema: contentSchema,
              toolNames: profile.toolNames, fileSubmission: profile.fileSubmission, toolDescriptions: profile.toolDescriptions,
              submissionNudge: profile.submissionNudge },
          };
          const disclosed = verification ? messages.filter(message => message.role === "tool" && typeof message.content === "string")
            .flatMap(message => (message.content as string).split("\n").flatMap(text => {
              try { const reply = JSON.parse(text) as { accepted?: boolean; material?: unknown };
                return reply.accepted && reply.material ? [reply.material] : []; } catch { return []; }
            })).at(-1) : undefined;
          if (verification) {
            assert.equal((material as { sections: unknown[] }).sections.length, 2, "initial verification request remains blind");
            assert.equal(JSON.stringify(material).includes("comparison_draft"), false);
            assert.equal(Boolean(inspect), !disclosed, "inspection is published only before its immutable checkpoint");
            assert.equal(Boolean(submit), Boolean(disclosed), "final submission is published only after inspection");
          }
          const evaluation = verification && !disclosed ? undefined : draftFor(spec, taskResult(spec, disclosed), disclosed);
          const rejected = messages.some(
            (m) => m.role === "tool" && String(m.content).includes("evidence_selection_invalid"),
          );
          let name: string, args: unknown;
          if (verification && !disclosed) {
            name = "inspect_material";
            args = inspectionDraft(spec);
          } else {
            name = "submit_evaluation";
            args = evaluation;
            if (attribution && engine === "pi" && !rejected)
              (args as { correctness_evidence: { evidence_index: number }[] }).correctness_evidence[0]!.evidence_index = 999999;
          }
          const event = {
            id: "fixture-" + requests.length,
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
          };
          const chunks = [
            {
              ...event,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-" + requests.length,
                        type: "function",
                        function: { name, arguments: JSON.stringify(args) },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              ...event,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            },
          ];
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n",
          );
        } catch (error) {
          serverErrors.push(String(error));
          res.writeHead(500);
          res.end(String(error));
        }
      });
      const previous = process.env.EVAL_API_KEY;
      process.env.EVAL_API_KEY = "integration-fixture-secret";
      try {
        models.models.judge!.baseUrl = gateway.url + "/v1";
        models.models.judge!.thinking = "xhigh";
        const modelForStage = createModelResolver(models);
        config.execution.timeoutSeconds = 45;
        config.execution.idleTimeoutSeconds = 15;
        const options = {
          runId: "sdk-" + engine,
          debug: engine === "pi",
          output: config.output,
          engine,
          evaluatorVersion: fakeEvaluatorVersion,
          config,
          ...services,
          plan,
          policy: config.execution,
          modelForStage,
          concurrency: 2,
          retries: 0,
          retryDelaySeconds: 0,
        };
        const summary = await runEvaluation(options);
        assert.deepEqual(serverErrors, []);
        const failureFile = path.join(
          config.output.path,
          options.runId,
          "_internal/diagnostics/failures.jsonl",
        );
        const failures = (await exists(failureFile)) ? await readFile(failureFile, "utf8") : "";
        assert.equal(summary.completed_comparisons, 1, failures);
        assert.deepEqual(stageRequests, expectedStageRequests);
        const state = await readRunState(path.join(config.output.path, options.runId));
        const verificationTask = state.manifest.tasks.find(task => (task.data as TaskData).verificationOf)!;
        assert.equal(state.receipts[verificationTask.id].submissionStats!.contentSubmissions, 2,
          "the actual inspection and final submission both consume content budget");
        assert(state.receipts[verificationTask.id].audit.inspection);
        const acceptedRequestCount = requests.length;
        if (engine === "pi") {
          const task = options.plan.tasks.find((task) => task.stage === "attribution")!;
          const events: WorkerEvent[] = [];
          for await (const event of readJsonl(
            path.join(
              config.output.path,
              options.runId,
              "_internal",
              "tasks",
              task.id,
              "attempt-001/events.jsonl.gz",
            ),
          ))
            events.push(event as WorkerEvent);
          assert(
            events.some(
              (e) =>
                e.type === "model" &&
                object(e.data).type === "tool_execution_end" &&
                object(e.data).isError === true,
            ),
          );
        }
        const validation = await validateRun(path.join(config.output.path, options.runId));
        assert.equal(validation.valid, true, JSON.stringify(validation.errors));
        await runEvaluation(options);
        assert.equal(requests.length, acceptedRequestCount, "resume must not issue a request for any accepted task");
        for (const payload of requests) {
          assert.equal(payload.parallel_tool_calls, false);
          assert.equal(payload.reasoning_effort, "xhigh");
          assert.equal(String(payload.max_completion_tokens), "32768");
        }
      } finally {
        if (previous === undefined) delete process.env.EVAL_API_KEY;
        else process.env.EVAL_API_KEY = previous;
        await gateway.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
