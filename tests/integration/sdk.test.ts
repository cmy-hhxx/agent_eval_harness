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
import { comparisonProfile } from "@eval/agents/comparison";
import { criteriaProfile } from "@eval/agents/criteria";
import { buildPlan } from "@eval/workflows/comparison";
import { services } from "../fixtures/services.js";
import { runEvaluation } from "@eval/host";
import { validateRun } from "../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fixtureConfig, raw, taskResult } from "../fixtures/comparison.js";

for (const engine of ["pi", "prime"] as Engine[])
  test(
    `${engine}: real vendored SDK over HTTP worker, code tool, three stages and resume`,
    { timeout: 120000 },
    async () => {
      const { directory, config, models } = await fixtureConfig([[raw()], [], [raw()], []]);
      // This mock implements Chat Completions, independently of the production gateway protocol.
      models.models.judge!.api = "openai-completions";
      const requests: Record<string, unknown>[] = [],
        serverErrors: string[] = [];
      const stageRequests = { criteria: 0, attribution: 0, comparison: 0 };
      const expectedStageRequests = { criteria: 1, attribution: engine === "pi" ? 8 : 4, comparison: 2 };
      const gateway = await listen(async (req, res) => {
        try {
          assert.equal(req.headers.authorization, "Bearer integration-fixture-secret");
          const payload = object(await body(req));
          requests.push(payload);
          const tools = payload.tools as {
            function: { name: string; description: string; parameters: { properties: object } };
          }[];
          const submit = tools.find((t) => t.function.name === "submit_evaluation")!;
          assert(submit);
          assert(tools.some((t) => t.function.name === "submit_evaluation_file"));
          assert(!tools.some((t) => t.function.name === "set_task_contract"));
          const messages = payload.messages as {
            role: string;
            name?: string;
            content: unknown;
          }[];
          const ranCode = messages.some((m) => m.role === "tool");
          const attribution = "is_correct" in submit.function.parameters.properties;
          const criteria = "requirements" in submit.function.parameters.properties;
          const stage = criteria ? "criteria" : attribution ? "attribution" : "comparison";
          assert(++stageRequests[stage] <= expectedStageRequests[stage], `unexpected repeated ${stage} request`);
          const profile = criteria ? criteriaProfile : attribution ? attributionProfile : comparisonProfile;
          const descriptions = profile.toolDescriptions;
          if (criteria) assert.deepEqual(tools.map((tool) => tool.function.name).sort(), ["submit_evaluation", "submit_evaluation_file"]);
          for (const tool of tools)
            assert.equal(tool.function.description, descriptions[tool.function.name], tool.function.name);
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
            answer?: { final_evidence: { evidence_id: string }[] };
            candidates?: Record<string, { final_evidence: { evidence_id: string }[] }>;
          };
          const evidenceFor = () => ({
            evidence_id: material.answer!.final_evidence[0]!.evidence_id,
          });
          const spec = {
            prompt, inputs: [], evaluation: { id: stage, profile: profile.id,
              systemPrompt: profile.systemPrompt, outputSchema: profile.submissionSchema,
              toolNames: profile.toolNames, toolDescriptions: profile.toolDescriptions,
              submissionNudge: profile.submissionNudge },
          };
          const evaluation = draftFor(spec, taskResult(spec));
          const rejected = messages.some(
            (m) => m.role === "tool" && String(m.content).includes("evidence_id_invalid"),
          );
          const repaired = messages.some(
            (m) => m.role === "tool" && String(m.content).includes("fixed-evaluation-file"),
          );
          let name: string, args: unknown;
          if (criteria) {
            name = "submit_evaluation";
            args = evaluation;
          } else if (!ranCode) {
            name = "execute_code";
            args = {
              language: "python",
              code:
                engine === "pi"
                  ? "print(2+2)"
                  : `from pathlib import Path\nPath('evaluation.json').write_text(${JSON.stringify(JSON.stringify(evaluation))})`,
            };
          } else if (attribution && engine === "pi" && !rejected) {
            name = "submit_evaluation";
            const result = structuredClone(evaluation) as { correctness_evidence: { evidence_id: string }[] };
            result.correctness_evidence[0]!.evidence_id = "invented";
            args = result;
          } else if (attribution && engine === "pi" && !repaired) {
            name = "execute_code";
            args = {
              language: "python",
              code:
                "import json\nfrom pathlib import Path\np=Path('evaluation-draft.json')\nr=json.loads(p.read_text())\nr['correctness_evidence'][0]['evidence_id']=" +
                JSON.stringify(evidenceFor().evidence_id) +
                "\np.write_text(json.dumps(r,ensure_ascii=False))\nprint('fixed-evaluation-file')",
            };
          } else if (attribution) {
            name = "submit_evaluation_file";
            args = {
              path: engine === "pi" ? "evaluation-draft.json" : "evaluation.json",
            };
          } else {
            name = "submit_evaluation";
            args = evaluation;
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
          plan: await buildPlan(config),
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
        const expectedRequests = engine === "pi" ? 11 : 7;
        assert.equal(
          requests.length,
          expectedRequests,
          "submit must terminate without another model request",
        );
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
        assert.equal(requests.length, expectedRequests);
        for (const payload of requests) {
          assert.equal(payload.parallel_tool_calls, false);
          assert.equal(payload.reasoning_effort, "xhigh");
          assert.equal(String(payload.max_completion_tokens), "8192");
        }
      } finally {
        if (previous === undefined) delete process.env.EVAL_API_KEY;
        else process.env.EVAL_API_KEY = previous;
        await gateway.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
