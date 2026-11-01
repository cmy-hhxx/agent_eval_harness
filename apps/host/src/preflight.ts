import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exists, preflightPaths, runLayout } from "@eval/data";
import { loadIdentity } from "@eval/runtime/client";
import { boundProfiles, type HostConfig } from "./config.js";
import { ROOT, runtimePaths } from "./paths.js";

/** All startup dependencies are checked before model admission; no model is called. */
export async function preflightHost(host: HostConfig, runId?: string) {
  const issues: { check: string; reason: string }[] = [];
  for (const profile of boundProfiles(host.models)) if (!process.env[profile.apiKeyEnv])
    issues.push({ check: profile.apiKeyEnv, reason: "Missing model credential" });
  try { await loadIdentity("pi", ROOT); }
  catch (error) { issues.push({ check: "worker_build", reason: error instanceof Error ? error.message : String(error) }); }
  if (!await exists(runtimePaths.workerEntry)) issues.push({ check: "worker_entry", reason: "Worker entry is unavailable" });
  // A produced row must be routable to exactly one business partition; never infer it from the path.
  if (host.workflow === "attribution" && host.evaluation.output.layout === "business" && !host.evaluation.output.business)
    issues.push({ check: "output.business", reason: "归因正式输出必须声明业务类别（daily 或 lost）" });
  try {
    const { stdout } = await promisify(execFile)(process.env.EVAL_PYTHON || path.join(ROOT, ".venv/bin/python"), ["--version"], { timeout: 5000 });
    if (!stdout.includes("3.12.12")) throw new Error("Python 3.12.12 is required");
  } catch (error) { issues.push({ check: "python", reason: error instanceof Error ? error.message : String(error) }); }
  const directories = [host.evaluation.output.path, os.tmpdir(),
    process.env.EVAL_HOT_STATE_ROOT || path.join(os.homedir(), ".cache/eval-agent-harness/hot"),
    process.env.EVAL_LOG_DIR || path.join(ROOT, "log"),
    process.env.EVAL_LOG_LOCK_DIR || path.join(ROOT, ".runtime/log-writer")];
  for (const failure of await preflightPaths(directories, runId ? runLayout(host.evaluation.output, runId).directory : undefined))
    issues.push({ check: failure.path, reason: failure.reason });
  return issues;
}
