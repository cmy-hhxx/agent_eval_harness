import { isTraceAttributionTask, type AttributionTaskData } from "@eval/workflows/attribution";
import { normalizeInput } from "@eval/workflows/inputs";
import { parseEvidenceCoordinates } from "@eval/tools";
import { compactAgent } from "@eval/agents/compact";
import { sourceCompactReceipt, componentTask } from "../fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { object, type AgentProfile, type JsonObject, type RunState } from "@eval/contracts";
import { createRunRepository } from "@eval/data";
import { AgentRegistry, runEvaluation, createChannelRequests } from "@eval/host";
import { createBalancedModels } from "../../apps/host/src/balanced-models.js";
import { body, json, listen } from "@eval/runtime/http";
import { fixtureConfig, parsedMaterial } from "../fixtures/comparison.js";
import { services } from "../fixtures/services.js";
import { attributionAgent } from "@eval/agents/attribution";
import { attributionWorkflow, attributionRepository } from "@eval/workflows/attribution";
import { stagedAttributionPlan as planAttribution } from "../fixtures/shards.js";

for (const borrow of [false, true])
test(`pi: actual route usage survives ${borrow ? "gateway borrowing" : "quota failover"}`, { timeout: 60000 }, async () => {
  const { directory, config, models } = await fixtureConfig();
  const metrics: JsonObject[] = [], gatewayErrors: string[] = [];
  let requests = 0, quotaRequests = 0;
  const profile: AgentProfile = {
    id: "default", systemPrompt: "Evaluate JSON.", instructions: "Submit the score.", submissionNudge: "Submit the score.",
    toolNames: [], fileSubmission: false, toolDescriptions: { submit_evaluation: "Submit the score." },
    renderPrompt: () => "Submit score 7.", requestSchema: { type: "object" },
    submissionSchema: { type: "object", required: ["score"], properties: { score: { type: "number" } }, additionalProperties: false },
  };
  const gateway = await listen(async (req, res) => {
    try {
      if (req.url!.startsWith("/preferred/")) {
        quotaRequests++;
        return json(res, { error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota." } }, 429);
      }
      assert.equal(req.headers.authorization, "Bearer local-fixture-secret");
      const payload = object(await body(req));
      assert((payload.tools as JsonObject[]).some(tool => tool.name === "submit_evaluation"));
      assert.equal(++requests, 1);
      const call = { type: "function_call", id: "fc_score", call_id: "call_score", name: "submit_evaluation", arguments: JSON.stringify({ score: 7 }) };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: { id: "resp_score", status: "completed", output: [call],
          usage: { input_tokens: 40, output_tokens: 15, total_tokens: 55,
            input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 5 } } } },
      ].map((event, sequence_number) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
    } catch (error) { gatewayErrors.push(String(error)); res.writeHead(500); res.end(String(error)); }
  });
  const repository = createRunRepository<RunState>({
    encode: state => structuredClone(state), references: () => [], resultId: row => String(row.id), decode: state => state,
  }, (task, state) => ({ id: task.id, file: "results.jsonl", row: { id: task.id, result: state.receipts[task.id].evaluation } }));
  let held: { release(): void } | undefined;
  const previous = process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway, previousQuota = process.env.SDK_QUOTA_TEST_KEY;
  process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway = "local-fixture-secret";
  process.env.SDK_QUOTA_TEST_KEY = "preferred-fixture-secret";
  try {
    models.models.judge!.baseUrl = gateway.url + "/v1";
    models.models.judge!.thinking = "off";
    models.channels.openai = { ...models.models.judge, provider: "openai", baseUrl: gateway.url + "/preferred", apiKeyEnv: "SDK_QUOTA_TEST_KEY" };
    const routing = createBalancedModels(models, ["openai", "evaluation-gateway"]);
    const control = createChannelRequests({ openai: 1, "evaluation-gateway": 1 });
    if (borrow) held = await control.acquire({ callId: "held", runId: "held", taskId: "held", stage: "attribution",
      model: routing.modelRoutesForTask({ stage: "attribution" }).find(model => model.provider === "openai")! }, new AbortController().signal);
    await runEvaluation({
      runId: "route-usage", output: config.output, config,
      plan: { tasks: [{ id: "score", stage: "score", inputIds: {}, dependencies: {}, data: {} }], inputs: {}, summary: {} },
      engine: "pi", evaluatorVersion: "fixture", modelForStage: () => routing.modelForStage("attribution"),
      modelForTask: (task, previousChannel) => routing.modelForTask({ ...task, stage: "attribution" }, previousChannel),
      modelRequests: control, modelRoutesForTask: task => routing.modelRoutesForTask({ ...task, stage: "attribution" }),
      onModelQuotaExhausted: (model, task) => routing.onModelQuotaExhausted(model, { ...task, stage: "attribution" }),
      policy: config.execution, concurrency: 1, retries: 0, retryDelaySeconds: 0,
      agents: new AgentRegistry([{ id: "score", profiles: { default: profile } }]), repository,
      taskSource: { id: "score", bind: () => ({ agent: "score", profile: "default", request: { input: {}, sources: {} } }) },
      runtime: services.runtime, logger: { async error() {}, async evaluation() { return true; },
        async event(event, context) { if (event === "attempt_metrics") metrics.push(context); return true; } },
    });
    assert.deepEqual(gatewayErrors, []);
    assert.equal(quotaRequests, borrow ? 0 : 1);
    assert.equal(requests, 1);
    const measured = metrics.find(row => row.confirmed === true)!;
    assert.equal(measured.channel, "evaluation-gateway");
    assert.deepEqual(measured.model_usage, [{ channel: "evaluation-gateway", model: models.models.judge!.model,
      usage: { input: 10, output: 15, cacheRead: 30, cacheWrite: 0, totalTokens: 55 }, reasoningTokens: 5 }]);
    const saved = await repository.readRun(path.join(config.output.path, "route-usage"));
    assert.equal(saved.manifest.states.score.attempts, borrow ? 1 : 2);
    assert.deepEqual(saved.receipts.score.evaluation, { score: 7 });
  } finally {
    held?.release();
    if (previousQuota === undefined) delete process.env.SDK_QUOTA_TEST_KEY; else process.env.SDK_QUOTA_TEST_KEY = previousQuota;
    if (previous === undefined) delete process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway; else process.env.EVAL_CHANNEL_KEY_evaluation_Hgateway = previous;
    await gateway.close(); await rm(directory, { recursive: true, force: true });
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
  const component = componentTask(candidate, compact, plan.inputs, "答案合成·取值");
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
      const material = parsedMaterial({ prompt: text }) as { submission_example: unknown; final_answer: { reference: { evidence_index: number } }[];
        investigated_components: { actor_index: number; contains_final_generation?: boolean }[] };
      const finalIndex = component ? material.final_answer[0]!.reference.evidence_index : 1;
      const args = compact ? material.submission_example : component ? { content: "最终运算结果错误。", evidence: [finalIndex], tool_error_reviews: [],
        problems: [{ actor_index: material.investigated_components.find(member => member.contains_final_generation)!.actor_index, tool_error_indices: [], label: "基本算术计算错误", definition: "基本运算的最终结果与正确数值不符。",
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
