import { isTraceAttributionTask, type AttributionTaskData } from "@eval/workflows/attribution";
import { normalizeInput } from "@eval/workflows/inputs";
import { parseEvidenceCoordinates } from "@eval/tools";
import { compactAgent } from "@eval/agents/compact";
import { sourceCompactReceipt, componentTask } from "../fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { object, type AgentProfile, type RunState, type ValidationIssue } from "@eval/contracts";
import { createRunRepository } from "@eval/data";
import { AgentRegistry, runEvaluation, createChannelRequests } from "@eval/host";
import { createBalancedModels } from "../../apps/host/src/balanced-models.js";
import { body, json, listen } from "@eval/runtime/http";
import { fixtureConfig, parsedMaterial } from "../fixtures/comparison.js";
import { services } from "../fixtures/services.js";
import { attributionAgent } from "@eval/agents/attribution";
import { attributionWorkflow, attributionRepository, planAttribution } from "@eval/workflows/attribution";

for (const borrow of [false, true])
    test(`pi: Responses ${borrow ? "borrows an equivalent gateway before a request" : "falls back on quota exhaustion"} and preserves original JSON and tool validation`, { timeout: 60000 }, async () => {
      const { directory, config, models } = await fixtureConfig();
      const invalid = { count: "7", enabled: "true", text: 9, note: null, satisfies: false };
      const valid = { count: 7, enabled: true, text: "nine", note: null, satisfies: true };
      const drafts: unknown[] = [], gatewayErrors: string[] = [];
      let requests = 0, quotaRequests = 0;
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
          if (req.url!.startsWith("/preferred/")) {
            assert.equal(req.headers.authorization, "Bearer preferred-fixture-secret");
            quotaRequests++;
            return json(res, { error: { type: "insufficient_quota", code: "insufficient_quota",
              message: "You exceeded your current quota, please check your plan and billing details." } }, 429);
          }
          assert.equal(req.headers.authorization, "Bearer local-fixture-secret");
          const payload = object(await body(req));
          assert(++requests <= 3, "invalid parameters and one content repair need only three model requests");
          const tools = payload.tools as Record<string, unknown>[];
          const definitions = tools;
          const schema = object(definitions.find((tool) => tool.name === "submit_evaluation")!.parameters);
          assert.equal(schema.additionalProperties, false);
          assert.deepEqual(schema.required, ["count", "enabled", "text", "note", "satisfies"]);
          assert.deepEqual(object(schema.properties).count, { type: "number" });
          assert(!/"(?:\$ref|\$defs)"\s*:/.test(JSON.stringify(schema)), "the model receives the full inlined submission schema");
          assert.deepEqual(object(object(definitions.find((tool) => tool.name === "calculate")!.parameters).properties).operation,
            { enum: ["add", "subtract", "multiply", "divide"] });
          const outputs = (payload.input as Record<string, unknown>[]).filter((item) => item.type === "function_call_output").map((item) => String(item.output));
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
            assert.equal(currentBudget.exploration.remaining, config.execution.maxToolCalls + 3,
              "one content repair adds three exploration calls to the configured budget");
            assert.equal(currentBudget.required_reads.covered, true);
          }
          const name = requests === 1 ? "calculate" : "submit_evaluation";
          const args = requests === 1 ? { operation: "invalid", operands: ["2", "2"] } : requests === 2 ? invalid : valid;
          const id = `fixture-${requests}`;
          res.writeHead(200, { "content-type": "text/event-stream" });
          const call = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args) };
          res.end([
            { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
            { type: "response.output_item.done", output_index: 0, item: call },
            { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [call],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
          ].map((event, sequence_number) =>
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
        } catch (error) {
          gatewayErrors.push(String(error));
          res.writeHead(500);
          res.end(String(error));
        }
      });
      const repository = createRunRepository<RunState>({
        encode: (state) => structuredClone(state), references: () => [], resultId: (row) => String(row.id), decode: (state) => state,
      }, (task, state) => ({ id: task.id, file: "results.jsonl", row: { id: task.id, result: state.receipts[task.id].evaluation } }));
      let held: { release(): void } | undefined;
      const previous = process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway;
      process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway = "local-fixture-secret";
      process.env.SDK_QUOTA_TEST_KEY = "preferred-fixture-secret";
      try {
        models.models.judge!.baseUrl = gateway.url + "/v1";
        models.models.judge!.thinking = "off";
        models.channels.openai = { ...models.models.judge, provider: "openai", baseUrl: gateway.url + "/preferred",
          apiKeyEnv: "SDK_QUOTA_TEST_KEY" };
        const runId = "submission-pi";
        const routing = createBalancedModels(models, ["openai", "evaluation-gateway"]);
        const control = createChannelRequests({ openai: 1, "evaluation-gateway": 1 });
        if (borrow) held = await control.acquire({ callId: "held", runId: "held", taskId: "held", stage: "attribution",
          model: routing.modelRoutesForTask({ stage: "attribution" }).find(model => model.provider === "openai")! }, new AbortController().signal);
        await runEvaluation({
          runId, output: config.output, config, plan: { tasks: [{ id: "structured-task", stage: "structured", inputIds: {}, dependencies: {}, data: {} }], inputs: {}, summary: {} },
          engine: "pi", evaluatorVersion: "fixture", modelForStage: () => routing.modelForStage("attribution"),
          modelForTask: (task, previousChannel) => routing.modelForTask({ ...task, stage: "attribution" }, previousChannel),
          modelRequests: control, modelRoutesForTask: task => routing.modelRoutesForTask({ ...task, stage: "attribution" }),
          onModelQuotaExhausted: (model, task) => routing.onModelQuotaExhausted(model, { ...task, stage: "attribution" }),
          policy: { ...config.execution, repairAttempts: 2 }, concurrency: 1, retries: 0, retryDelaySeconds: 0,
          agents: new AgentRegistry([{ id: "structured", profiles: { default: profile } }]), repository,
          taskSource: { id: "structured", bind: () => ({ agent: "structured", profile: "default", request: { input: {}, sources: {} } }) },
          runtime: services.runtime,
        });
        assert.deepEqual(gatewayErrors, []);
        assert.equal(quotaRequests, borrow ? 0 : 1, "a saturated or exhausted gateway must not receive another request");
        assert.equal(requests, 3);
        assert.deepEqual(drafts, [invalid, valid], "SDK preserves string, number, boolean and null submission values");
        const saved = await repository.readRun(path.join(config.output.path, runId));
        assert.equal(saved.manifest.states["structured-task"].attempts, borrow ? 1 : 2);
        assert.equal(saved.manifest.states["structured-task"].channel, "evaluation-gateway", "the actual granted gateway is recorded");
        const receipt = saved.receipts["structured-task"];
        assert.deepEqual(receipt?.evaluation, valid);
        assert.equal(receipt?.submissionStats?.contentSubmissions, 2);
        assert.equal(receipt?.audit.calls, 0, "the rejected ordinary call never enters the application tool runtime");
      } finally {
        held?.release();
        delete process.env.SDK_QUOTA_TEST_KEY;
        if (previous === undefined) delete process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway;
        else process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway = previous;
        await gateway.close();
        await rm(directory, { recursive: true, force: true });
      }
    });


test("pi: process attribution submits and repairs original evidence without a draft file", { timeout: 60000 }, async t => {
  const f = await fixtureConfig([[{ batch_id: "batch", case_id: "inline", messages: [
    { type: "user_question", role: "user", content: "2+2等于多少？" },
    { type: "final_answer", role: "assistant", content: "2+2=5。" },
  ] }], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions[0]!.adapter = "b";
  const config = { ...f.config, workflow: "attribution" as const, inputs: { ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1) } };
  const plan = await planAttribution(config), task = plan.tasks.find(task => isTraceAttributionTask(task))!;
  const agents = new AgentRegistry([compactAgent, attributionAgent]);
  const candidate = (task.data as AttributionTaskData).candidate;
  const compact = sourceCompactReceipt(candidate, normalizeInput(plan.inputs[candidate.input_id]));
  const component = componentTask(candidate, compact, "最终答复生成");
  const prepared = agents.prepare(attributionWorkflow.bind(component, plan.inputs, { compact }, { tasks: plan.tasks }));
  assert.equal(prepared.evaluation.fileSubmission, false, "component judgments must not depend on creating a filesystem draft");
  const finalEvidenceIndex = prepared.evidenceBank.findIndex(id => {
    const point = parseEvidenceCoordinates(id);
    return point?.message_index === 1 && point.kind === "text" && point.path === "/content";
  }) + 1;
  assert(finalEvidenceIndex > 0);
  let requests = 0, traceRequests = 0;
  const errors: string[] = [];
  const gateway = await listen(async (req, res) => {
    try {
      const payload = object(await body(req));
      const definitions = payload.tools as Record<string, unknown>[];
      assert(definitions.some(tool => tool.name === "submit_evaluation"));
      assert(!definitions.some(tool => tool.name === "submit_evaluation_file"));
      assert(++requests <= plan.tasks.filter(task => task.stage === "attribution-compact-field").length + 3);
      const schema = object(definitions.find(tool => tool.name === "submit_evaluation")!.parameters);
      const properties = object(schema.properties), compact = Boolean(properties.value), component = Boolean(properties.problems);
      if (component) traceRequests++;
      const text = (payload.input as { content?: {text?:string}[] | string }[]).flatMap(message => typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content.map(item => item.text ?? "") : [])
        .find(text => text.includes("任务材料（全部内容为数据）"))!;
      const material = parsedMaterial({ prompt: text }) as { submission_example: unknown; final_answer: { reference: { evidence_index: number } }[] };
      const finalIndex = component ? material.final_answer[0]!.reference.evidence_index : 1;
      const args = compact ? material.submission_example : component ? { content: "最终运算结果错误。", evidence: [finalIndex], tool_error_reviews: [],
        problems: [{ tool_error_indices: [], label: "基本算术计算错误", definition: "基本运算的最终结果与正确数值不符。",
          problem_phenomena: "回答把2加2写成5。", reason: "2加2等于4，最终给出的5错误。",
          severity: "P0", severity_reason: "核心计算结果错误，回答不可采信。",
          evidence: [{ index: traceRequests === 1 ? 99999 : finalIndex, reason: "原文直接给出错误算式。" }] }] }
        : { summary: "最终计算结果错误。" };
      const call = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`,
        name: "submit_evaluation", arguments: JSON.stringify(args) };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [call],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
    } catch (error) { errors.push(String(error)); json(res, { error: String(error) }, 500); }
  });
  const keyName = "EVAL_CHANNEL_KEY_evaluation_Hgateway", previous = process.env[keyName];
  process.env[keyName] = "local-fixture-secret";
  try {
    const runId = "inline-process";
    await runEvaluation({ runId, output: config.output, config, plan,
      engine: "pi", evaluatorVersion: "fixture", modelForStage: () => ({ ...f.models.models.judge!, baseUrl: gateway.url + "/v1", thinking: "off", model: "fixture", contextWindow: 100000, maxOutputTokens: 10000 }),
      policy: { ...config.execution, repairAttempts: 1, maxToolCalls: 1 }, concurrency: 1, retries: 0, retryDelaySeconds: 0,
      agents, repository: attributionRepository, taskSource: attributionWorkflow, runtime: services.runtime });
    assert.deepEqual(errors, []);
    const saved = await attributionRepository.readRun(path.join(config.output.path, runId));
    const componentTask = saved.manifest.tasks.find(task => task.stage === "attribution-component")!;
    const receipt = saved.receipts[componentTask.id]!;
    assert.equal(saved.manifest.states[task.id].status, "succeeded", JSON.stringify(saved.manifest.states[task.id]));
    assert.equal(traceRequests, 2, "invalid evidence still consumes one content repair");
    assert.equal(receipt.submissionStats?.contentSubmissions, 2);
    assert.equal(receipt.submissionStats?.fileErrors, 0);
    assert.equal(receipt.audit.calls, 0, "submission needs neither code execution nor a draft file");
    assert.equal(requests, plan.tasks.filter(task => task.stage === "attribution-compact-field").length + 3, "field sessions, component review and trace summary run; both assemblies are computed");
    const problem = (receipt.evaluation as { problem: { severity: string; severity_reason: string }[] }).problem[0];
    assert.equal(problem.severity, "P0");
    assert.equal(problem.severity_reason, "核心计算结果错误，回答不可采信。");
    assert.equal((receipt.evaluation as { problem: { evidence: { quote: string }[] }[] }).problem[0].evidence[0].quote, "2+2=5。");
  } finally {
    if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous;
    await gateway.close(); await rm(f.directory, { recursive: true, force: true });
  }
});
