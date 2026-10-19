import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { object } from "@eval/contracts";
import { body, listen, json } from "@eval/runtime/http";
import { runModelProbe } from "../../apps/host/src/model-probe.js";
import { ROOT } from "../fixtures/services.js";

const executeFile = promisify(execFile);

for (const engine of ["pi", "prime"] as const) for (const scenario of ["complete", "missing-usage", "partial-usage", "wrong-final", "missing-terminal", "extra-tool", "provider-error"] as const)
  test(`${engine} model probe validates Responses tools, terminal output and usage: ${scenario}`, { timeout: 30000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "model-probe-test-")), previous = process.env.EVAL_CONFIG_FILE;
    const requests: Record<string, unknown>[] = [], errors: string[] = [];
    const gateway = await listen(async (req, res) => {
      try {
        assert.equal(req.url, "/v1/responses");
        assert.equal(req.headers.authorization, "Bearer fixture-probe-secret");
        const payload = object(await body(req));
        requests.push(payload);
        assert(requests.length <= 2, "probe must never start a third request");
        assert.equal(payload.max_output_tokens, 512);
        assert.equal(payload.parallel_tool_calls, false);
        assert((payload.tools as { name: string }[]).some(tool => tool.name === "probe_echo"));
        if (scenario === "provider-error") return json(res, { error: { message: "fixture-probe-secret rejected", type: "authentication_error" } }, 401);
        let item: Record<string, unknown>;
        if (requests.length === 1) item = { type: "function_call", id: "fc_probe", call_id: "call_probe", name: "probe_echo", arguments: JSON.stringify({ value: "probe" }) };
        else {
          const output = (payload.input as Record<string, unknown>[]).find(value => value.type === "function_call_output");
          assert(output, "the second request must contain the actual tool result");
          assert.equal(output.call_id, "call_probe");
          const token = JSON.parse(String(output.output)).token;
          assert.match(token, /^[a-f0-9-]{36}$/);
          item = { type: "message", id: "message_probe", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: scenario === "wrong-final" ? "wrong" : token, annotations: [] }] };
          if (scenario === "extra-tool") item = { type: "function_call", id: "fc_extra", call_id: "call_extra", name: "probe_echo", arguments: JSON.stringify({ value: "probe" }) };
        }
        const events = [
          { type: "response.output_item.added", output_index: 0, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : { content: [] }) } },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: `response_${requests.length}`, status: "completed", output: [item],
            ...(scenario === "missing-usage" ? {} : { usage: scenario === "partial-usage" ? { total_tokens: 15 } : { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }) } },
        ];
        if (scenario === "missing-terminal" && requests.length === 2) events.pop();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
      } catch (error) { errors.push(String(error)); json(res, { error: "fixture error" }, 500); }
    });
    await writeFile(path.join(directory, "config.ini"), `[channel.evaluation-gateway]\nbase_url=${gateway.url}/v1\napi_key=fixture-probe-secret\nmodels=local-model\ncontext_window=16384\nmax_output_tokens=4096\n`);
    await writeFile(path.join(directory, "models.json"), JSON.stringify({ models: { judge: { model: "local-model", thinking: "off" } } }));
    process.env.EVAL_CONFIG_FILE = path.join(directory, "config.ini");
    try {
      const options = { configPaths: [path.join(ROOT, "configs/host.json"), path.join(directory, "models.json")], engine };
      const planned = await runModelProbe(options);
      assert.equal(planned.status, "planned");
      assert.equal(planned.attempts, 0);
      assert.equal(requests.length, 0, "dry run must never call /models or inference");
      let result: Awaited<ReturnType<typeof runModelProbe>>;
      if (engine === "prime" && scenario === "provider-error") {
        const child = await executeFile(process.execPath, ["--input-type=module", "-e",
          `import { runModelProbe } from ${JSON.stringify(path.join(ROOT, "dist/apps/host/src/model-probe.js"))};\nconsole.log(JSON.stringify(await runModelProbe(${JSON.stringify({ ...options, execute: true })})));`]);
        result = JSON.parse(child.stdout);
        assert.match(child.stderr, /provider stream failure/);
        assert(!child.stderr.includes("fixture-probe-secret"), "the actual SDK stderr must redact echoed credentials");
      } else result = await runModelProbe({ ...options, execute: true });
      assert.deepEqual(errors, []);
      assert.equal(result.attempts, 1);
      assert.equal(result.status, scenario === "complete" ? "passed" : "failed");
      assert(!JSON.stringify(result).includes("fixture-probe-secret"));
      if (scenario === "provider-error") assert.equal(requests.length, 1);
      else {
        assert.equal(result.modelRequests, 2);
        assert.equal(result.toolCalls, 1);
        assert.equal(requests.length, 2);
      }
      if (scenario === "complete") assert.equal(result.usage.totalTokens, 30);
      if (scenario === "missing-usage" || scenario === "partial-usage") assert.match(result.error!, /missing token usage/);
      if (scenario === "missing-terminal") assert.match(result.error!, /stream ended before a terminal response event/);
    } finally {
      if (previous === undefined) delete process.env.EVAL_CONFIG_FILE; else process.env.EVAL_CONFIG_FILE = previous;
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
