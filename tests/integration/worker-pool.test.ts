import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_POLICY, object, type AgentProfile, type RunState } from "@eval/contracts";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { createRunRepository } from "@eval/data";
import { body, json, listen, request } from "@eval/runtime/http";
import { startWorkerPool } from "@eval/runtime/worker";
import { piBackend } from "@eval/runtime/pi";
import { fakeIdentity } from "../fixtures/comparison.js";
import { ROOT, services } from "../fixtures/services.js";

test("the Worker CLI publishes independent slots in one process and closes every listener", { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "worker-pool-cli-"));
  const child = fork(path.join(ROOT, "dist/apps/worker/src/cli.js"), ["--engine", "pi", "--directory", directory,
    "--root", ROOT, "--slots", "3"], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, PI_OFFLINE: "1" } });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  const closed = once(child, "close");
  t.after(async () => { child.kill("SIGTERM"); await closed; await rm(directory, { recursive: true, force: true }); });
  const ready = await Promise.race([once(child, "message").then(([message]) => message as { url: string; urls: string[] }),
    closed.then(() => { throw new Error("Worker startup failed: " + stderr); })]);
  assert.equal(ready.urls.length, 3);
  assert.equal(new Set(ready.urls).size, 3);
  assert.equal(ready.url, ready.urls[0]);
  for (const url of ready.urls) assert.equal((await request<{ activeAttempt: string | null }>(url + "/api/health")).activeAttempt, null);
  child.kill("SIGTERM");
  assert.equal((await closed)[0], 0);
  for (const url of ready.urls) await assert.rejects(fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) }));
});

  test(`pi: one SDK backend serves eight concurrent isolated sessions across two channels`, { timeout: 30000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "worker-pool-sdk-"));
    const keys = ["POOL_CHANNEL_A", "POOL_CHANNEL_B"], previous = keys.map(key => process.env[key]);
    keys.forEach((key, index) => { process.env[key] = "fixture-secret-" + index; });
    let release!: () => void, active = 0, peak = 0, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), errors: string[] = [];
    const gateway = await listen(async (req, res) => {
      try {
        const payload = object(await body(req)), messages = payload.input as { role?: string; content?: unknown }[];
        const content = messages.findLast(message => message.role === "user")!.content;
        const text = typeof content === "string" ? content : (content as { text: string }[]).map(part => part.text).join("");
        const { value } = JSON.parse(text) as { value: number };
        assert.equal(req.headers.authorization, "Bearer fixture-secret-" + value % 2);
        assert.equal(req.url, `/channel-${value % 2}/responses`);
        assert.equal(object(payload.reasoning).effort, "high");
        calls++; active++; peak = Math.max(peak, active);
        if (active === 8) release();
        await gate;
        const call = { type: "function_call", id: `fc_${value}`, call_id: `call_${value}`, name: "submit_evaluation", arguments: JSON.stringify({ score: value }) };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([{ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
          { type: "response.output_item.done", output_index: 0, item: call },
          { type: "response.completed", response: { id: `response_${value}`, status: "completed", output: [call],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }]
          .map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
        active--;
      } catch (error) { errors.push(String(error)); release(); json(res, { error: "fixture error" }, 500); }
    });
    const backend = piBackend({ ...fakeIdentity, engine: "pi" });
    const pool = await startWorkerPool(backend, path.join(directory, "worker"), 8);
    t.after(async () => {
      release(); await pool.close(); await gateway.close(); await rm(directory, { recursive: true, force: true });
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    });
    const profile: AgentProfile = { id: "default", systemPrompt: "Submit the supplied number.", instructions: "Submit JSON.",
      submissionNudge: "Submit JSON.", toolNames: [], fileSubmission: false, toolDescriptions: { submit_evaluation: "Submit score." },
      renderPrompt: input => JSON.stringify(input), requestSchema: { type: "object" },
      submissionSchema: { type: "object", additionalProperties: false, required: ["score"], properties: { score: { type: "number" } } } };
    const repository = createRunRepository<RunState>({ encode: state => structuredClone(state), references: () => [],
      resultId: row => String(row.id), decode: state => state }, (task, state) => ({ id: task.id, file: "scores.jsonl", row: { id: task.id, result: state.receipts[task.id].evaluation } }));
    const tasks = Array.from({ length: 8 }, (_, value) => ({ id: randomUUID(), stage: "numeric", inputIds: {}, dependencies: {}, data: { value } }));
    await runEvaluation({ ...services, agents: new AgentRegistry([{ id: "numeric", profiles: { default: profile } }]), repository,
      taskSource: { id: "pool", bind: task => ({ agent: "numeric", profile: "default", request: { input: task.data as { value: number }, sources: {} } }) },
      engine: "pi", identity: backend.identity, evaluatorVersion: "fixture", runId: "pool", output: { kind: "directory", path: directory },
      config: {}, snapshots: {}, report: async () => ({}), plan: { tasks, inputs: {}, summary: {} },
      modelForStage: () => { throw Error("Task routing is required"); }, modelForTask: task => {
        const channel = (task.data as { value: number }).value % 2;
        return { provider: "pool-" + channel, baseUrl: `${gateway.url}/channel-${channel}`, api: "openai-responses",
          apiKeyEnv: keys[channel], model: "fixture-model", thinking: "high", contextWindow: 16384, maxOutputTokens: 1024 };
      }, policy: { ...DEFAULT_POLICY, timeoutSeconds: 15, idleTimeoutSeconds: 10 }, concurrency: 8,
      retries: 0, retryDelaySeconds: 0, workerUrls: pool.urls, signal: AbortSignal.timeout(20000) });
    assert.deepEqual(errors, []);
    assert.equal(peak, 8, "all sessions must be active before any gateway result is released");
    assert.equal(calls, 8);
    const state = await repository.readRun(path.join(directory, "pool"));
    for (const task of tasks) assert.deepEqual(state.receipts[task.id].evaluation, { score: task.data.value });
  });
