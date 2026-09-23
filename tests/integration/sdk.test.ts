import test from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import type { Engine } from "../../packages/contracts/src/index.js";
import { ROOT, body, listen, object } from "../../packages/contracts/src/io.js";
import { buildPlan, loadConfig } from "../../packages/pairwise-eval/src/input.js";
import { pairwisePack } from "../../packages/pairwise-eval/src/index.js";
import { runEvaluation } from "../../apps/host/src/runner.js";
import { validateRun } from "../../apps/host/src/validate.js";
import { fixtureConfig, pairResult, raw } from "../host/fixtures.js";

for (const engine of ["pi", "prime"] as Engine[])
  test(
    `${engine}: real vendored SDK over HTTP worker, code tool, two stages and resume`,
    { timeout: 120000 },
    async () => {
      const { directory, config } = await fixtureConfig([[raw()], [], [raw()], []]);
      const requests: Record<string, unknown>[] = [],
        serverErrors: string[] = [];
      const gateway = await listen(async (req, res) => {
        try {
          assert.equal(req.headers.authorization, "Bearer integration-fixture-secret");
          const payload = object(await body(req));
          requests.push(payload);
          const tools = payload.tools as { function: { name: string; parameters: { properties: object } } }[];
          const submit = tools.find((t) => t.function.name === "submit_evaluation")!;
          assert(submit);
          assert(!tools.some((t) => t.function.name === "set_task_contract"));
          const messages = payload.messages as { role: string; name?: string; content: unknown }[];
          const ranCode = messages.some((m) => m.role === "tool");
          const correctness = "is_correct" in submit.function.parameters.properties;
          const name = ranCode ? "submit_evaluation" : "execute_code";
          const args = ranCode
            ? correctness
              ? {
                  is_correct: true,
                  correctness_reason: "计算结果与标准答案一致。",
                  evidence: [{ message_index: 1, quote: "2+2=4" }],
                }
              : pairResult()
            : { language: "python", code: "print(2+2)" };
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
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
        config.judge = (await loadConfig(path.join(ROOT, "configs/host.json"), {
          EVAL_BASE_URL: gateway.url + "/v1",
        })).judge;
        config.judge.correctness.model = "fixture";
        config.judge.pairwise.model = "fixture";
        config.judge.correctness.thinking = "off";
        config.judge.pairwise.thinking = "off";
        config.execution.timeoutSeconds = 45;
        config.execution.idleTimeoutSeconds = 15;
        const { correctness, pairwise, ...common } = config.judge;
        const options = {
          runId: "sdk-" + engine,
          outputDir: config.outputDir,
          cacheDir: config.cacheDir,
          engine,
          config,
          pack: pairwisePack,
          plan: await buildPlan(config),
          policy: config.execution,
          modelForStage: (stage: string) => ({
            ...common,
            ...(stage === "correctness" ? correctness : pairwise),
          }),
          concurrency: 2,
          retries: 0,
          retryDelaySeconds: 0,
        };
        const summary = await runEvaluation(options);
        assert.deepEqual(serverErrors, []);
        const failures = await readFile(path.join(config.outputDir, options.runId, "failures.jsonl"), "utf8");
        assert.equal(summary.completed_comparisons, 1, failures);
        assert.equal(requests.length, 6, "submit must terminate without another model request");
        const validation = await validateRun(path.join(config.outputDir, options.runId));
        assert.equal(validation.valid, true, JSON.stringify(validation.errors));
        await runEvaluation({ ...options, resume: true });
        assert.equal(requests.length, 6);
        for (const payload of requests) {
          assert.equal(payload.parallel_tool_calls, false);
          assert(["4096", "8192"].includes(String(payload.max_completion_tokens)));
        }
      } finally {
        if (previous === undefined) delete process.env.EVAL_API_KEY;
        else process.env.EVAL_API_KEY = previous;
        await gateway.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
