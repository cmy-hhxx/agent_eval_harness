import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { testEvaluationOutput } from "../../../apps/host/src/config.js";
import { ROOT } from "../../fixtures/services.js";

test("test evaluations stay in the owning source's test_eval for daily and nested task outputs", () => {
  for (const source of ["0_wencai", "1_aime", "2_ifind"]) {
    const root = `/mnt/fin_bench/eval_data/${source}/eval_output`;
    for (const category of ["0_daily_eval", "1_task_eval/post_train_model", "test_eval"])
      assert.equal(testEvaluationOutput(`${root}/${category}`), `${root}/test_eval`);
    assert.equal(testEvaluationOutput(`${root}/0_daily_eval`, `${root}/test_eval/benchmark`), `${root}/test_eval/benchmark`);
    for (const outside of [`${root}/0_daily_eval`, `${root}/test_eval-other`, `${root}/test_eval/../outside`, "/tmp/evaluation"])
      assert.throws(() => testEvaluationOutput(`${root}/0_daily_eval`, outside), /Test evaluation output/);
  }
  assert.throws(() => testEvaluationOutput("/runtime/data/runs/comparison"), /source's eval_output/);
});

test("workbench initialization creates each source's test_eval and never creates runtime run output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-output-init-"));
  const runtime = path.join(directory, "runtime"), data = path.join(directory, "data");
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts/workbench-init.mjs"), "--runtime-root", runtime, "--data-root", data],
      { cwd: ROOT, env: { ...process.env, WORKBENCH_ADMIN_PASSWORD: "fixture-password" }, stdio: "pipe" });
    for (const source of ["0_wencai", "1_aime", "2_ifind"])
      for (const category of ["0_daily_eval", "1_task_eval", "test_eval"])
        assert((await stat(path.join(data, source, "eval_output", category))).isDirectory());
    const host = JSON.parse(await readFile(path.join(runtime, "config/host.json"), "utf8"));
    const pilot = JSON.parse(await readFile(path.join(runtime, "config/test-eval.json"), "utf8"));
    assert.equal(host.output.path, path.join(data, "0_wencai/eval_output/0_daily_eval"));
    assert.equal(pilot.output.path, path.join(data, "0_wencai/eval_output/test_eval"));
    await assert.rejects(stat(path.join(runtime, "data/runs")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
