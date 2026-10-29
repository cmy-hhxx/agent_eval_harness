import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { exists, runLock } from "@eval/data";
import { loadConfig, parseSettings } from "@eval/host-app/config";
import { initializeServices } from "@eval/host-app/composition";
import { preflightHost } from "../../../apps/host/src/preflight.js";
import { ROOT } from "../../fixtures/services.js";

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
  unlock = await runLock(path.join(host.evaluation.output.path, "owned"));
  const issues = await preflightHost(host, "owned");
  assert(issues.some(issue => issue.check === settings.channels["evaluation-gateway"].apiKeyEnv));
  assert(issues.some(issue => issue.check === "python"));
  assert(issues.some(issue => issue.check === blocked));
  assert(issues.some(issue => issue.reason.includes("live owner")));
});
