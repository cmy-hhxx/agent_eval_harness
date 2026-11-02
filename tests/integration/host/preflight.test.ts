import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { exists, runLayout, runLock } from "@eval/data";
import { loadConfig, parseSettings } from "@eval/host-app/config";
import { initializeServices } from "@eval/host-app/composition";
import { preflightHost } from "../../../apps/host/src/preflight.js";
import { ROOT } from "../../fixtures/services.js";

test("an attribution run declares its category independently of user-selected output directory names", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "business-partition-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = parseSettings("[channel.evaluation-gateway]\nbase_url=http://127.0.0.1:1/v1\napi_key=\nmodel=fixture\nmodels=fixture\n");
  const file = path.join(directory, "run.json");
  const layered = async (output: unknown, partition = "1_lost_user_eval") => {
    const inputs = { versions: [{ id: "v1", name: "v1", adapter: "a", sources: [
      { kind: "file", path: path.join(directory, "eval_input", partition, "model", "2026-09-01.jsonl") }] }] };
    await writeFile(file, JSON.stringify({ workflow: "attribution", inputs, output }));
    return [path.join(ROOT, "configs/host.json"), path.join(ROOT, "configs/attribution.json"), file];
  };
  const lost = { kind: "directory", layout: "business", path: path.join(directory, "1_lost_user_eval"), business: "lost" };
  assert.equal((await loadConfig(await layered(lost), settings)).evaluation.output.business, "lost");
  // The input folder's `_input` suffix stays on the input side.
  const daily = await loadConfig(await layered({ ...lost, business: "daily", path: path.join(directory, "0_daily_eval") }, "0_daily_eval_input"), settings);
  assert.equal(daily.evaluation.output.business, "daily");
  assert.equal((await loadConfig(await layered({ ...lost, path: path.join(directory, "custom-output") }), settings)).evaluation.output.business, "lost");
  const { business: _business, ...undeclared } = lost;
  const issues = await preflightHost(await loadConfig(await layered(undeclared), settings), "undeclared");
  assert(issues.some(issue => issue.check === "output.business"), "the category is never inferred from the path");
});

test("INI log paths are applied before logger creation and startup reports all missing dependencies", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "startup-preflight-"));
  const names = ["EVAL_LOG_DIR", "EVAL_LOG_LOCK_DIR", "EVAL_HOT_STATE_ROOT", "EVAL_PYTHON", "EVAL_CHANNEL_KEY_evaluation_Hgateway"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let unlock: (() => Promise<void>) | undefined;
  t.after(async () => { await unlock?.(); for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  } await rm(directory, { recursive: true, force: true }); });
  process.env.EVAL_LOG_DIR = path.join(directory, "wrong-log");
  const settings = parseSettings(`[channel.evaluation-gateway]\nbase_url=http://127.0.0.1:1/v1\napi_key=\nmodel=fixture\nmodels=fixture\n[environment]\nEVAL_LOG_DIR=${path.join(directory, "configured-log")}\nEVAL_LOG_LOCK_DIR=${path.join(directory, "log-lock")}\n`);
  const host = await loadConfig(path.join(ROOT, "configs/host.json"), settings);
  await initializeServices();
  assert(await exists(path.join(directory, "configured-log/runtime.log")));
  assert.equal(await exists(path.join(directory, "wrong-log")), false);
  const blocked = path.join(directory, "blocked"); await writeFile(blocked, "not a directory");
  process.env.EVAL_HOT_STATE_ROOT = blocked;
  process.env.EVAL_PYTHON = path.join(directory, "missing-python");
  host.evaluation.output.path = path.join(directory, "results");
  unlock = await runLock(runLayout(host.evaluation.output, "owned").directory);
  const issues = await preflightHost(host, "owned");
  assert(issues.some(issue => issue.check === settings.channels["evaluation-gateway"].apiKeyEnv));
  assert(issues.some(issue => issue.check === "python"));
  assert(issues.some(issue => issue.check === blocked));
  assert(issues.some(issue => issue.reason.includes("live owner")));
});
