import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readInputCatalog, readJsonl, writeJsonl } from "@eval/data";
import { buildPlan, indexDataset, reconcileRun, selectDataset, type EvalConfig, type InputDatasetIndex } from "@eval/workflows/comparison";
import { emptyUsage, type RunState } from "@eval/contracts";
import { fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

const exec = promisify(execFile);

test("named datasets index only business coordinates and select exact model files", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const catalog = path.join(directory, "catalog");
    const first = config.inputs.versions[0]!;
    const second = { id: "new_model", name: "New Model", comparison_tier: "Fast", adapter: "a", sources: [{ kind: "file" as const, path: path.join(directory, "new_model.jsonl") }] };
    config.inputs.versions = [first, second];
    config.comparisons = [[first.id, second.id]];
    const selected = [first, second];
    for (const version of selected) {
      const named = path.join(directory, version.id + "-竞品对比.jsonl");
      const daily = path.join(directory, version.id + "-2026-09-24.jsonl");
      const taskRow = { ...raw("same-case", null, "大段消息 🦊".repeat(1000)), batch_id: "task-batch" };
      await writeFile(named, "\uFEFF" + JSON.stringify(taskRow) + "\r\n");
      await writeJsonl(daily, [{ ...raw("same-case"), batch_id: "daily-batch" }]);
      version.sources = [{ kind: "directory", path: directory, include: [path.basename(named), path.basename(daily)] }];
    }
    const all = await buildPlan(config, undefined, { materializeInputs: false });
    assert.equal(all.summary.cases, 2);
    const scoped = { ...config, inputs: { ...config.inputs, versions: selected.map((version) => ({
      ...version, sources: [{ kind: "file" as const, path: path.join(directory, version.id + "-竞品对比.jsonl") }],
    })) } };
    const index = await indexDataset(scoped, catalog, "competitor", "竞品对比");
    assert.equal(index.valid, 2);
    assert.equal(index.invalid, 0);
    assert.equal(index.files.length, 2);
    const metadata = await readFile(path.join(catalog, "competitor", index.records_file), "utf8");
    assert(!metadata.includes("大段消息"));
    assert(!JSON.stringify(index).includes("messages"));
    const records: { file: number; line: number; byte_offset: number; byte_length: number; batch_id: string; case_id: string }[] = [];
    for await (const row of readJsonl(path.join(catalog, "competitor", index.records_file))) records.push(row as typeof records[number]);
    assert.equal(records.length, 2);
    for (const row of records) {
      const original = await readFile(index.files[row.file]!.source);
      const parsed = JSON.parse(original.subarray(row.byte_offset, row.byte_offset + row.byte_length).toString("utf8"));
      assert.equal(parsed.batch_id, row.batch_id);
      assert.equal(parsed.case_id, row.case_id);
      assert.equal(row.line, 1);
    }
    const selectedConfig = await selectDataset(config, catalog, "competitor");
    assert.equal(selectedConfig.inputs.dataset_id, "competitor");
    assert.deepEqual(selectedConfig.inputs.versions.map((version) => version.id), [first.id, second.id]);
    assert.deepEqual(selectedConfig.inputs.versions.map((version) => version.sources.length), [1, 1]);
    const planned = await buildPlan(selectedConfig, undefined, { materializeInputs: false });
    assert.equal(planned.summary.cases, 1);
    assert.equal(planned.summary.comparison_tasks, 1);
    assert.deepEqual(planned.summary.issues, []);
    const state: RunState = {
      manifest: {
        format: "evaluation-run", debug: false, runId: "scoped", status: "interrupted",
        engine: fakeIdentity, evaluatorVersion: "fixture", config: selectedConfig,
        tasks: planned.tasks, inputCatalog: planned.catalog, inputs: {},
        states: Object.fromEntries(planned.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
        preflight: planned.summary, startedAt: Date.now(),
      },
      receipts: {}, usage: emptyUsage(), recordedAttempts: 0,
    };
    const resumed = await reconcileRun(directory, state, config);
    assert.equal(resumed.summary.cases, 1, "resume without --dataset must retain the original file selection");
    assert.equal((state.manifest.config as EvalConfig).inputs.dataset_id, "competitor");
    assert.equal((state.manifest.config as EvalConfig).inputs.versions[0]!.sources.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resume plans the current fair groups within the original model selection", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const original = await buildPlan(config);
    const state: RunState = {
      manifest: {
        format: "evaluation-run", debug: false, runId: "resume", status: "interrupted",
        engine: fakeIdentity, evaluatorVersion: "fixture", config: structuredClone(config),
        tasks: original.tasks, inputCatalog: original.catalog, inputs: {},
        states: Object.fromEntries(original.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
        preflight: original.summary, startedAt: Date.now(),
      },
      receipts: {}, usage: emptyUsage(), recordedAttempts: 0,
    };
    config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    const resumed = await reconcileRun(directory, state, config);
    assert.deepEqual(resumed.summary.comparisons, config.comparisons);
    assert.equal(resumed.summary.comparison_tasks, 2);
    assert(resumed.tasks.some((task) => task.id === original.tasks.find((old) => old.stage === "comparison")!.id));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI indexes a named dataset and preflights it without scanning unrelated model files", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const overlay = path.join(directory, "comparison.json");
    await writeFile(overlay, JSON.stringify({ comparisons: [["a_fast", "b_fast"]] }));
    await writeJsonl(config.inputs.versions.find((v) => v.id === "b_fast")!.sources[0]!.path, [{
      ...raw(),
      messages: [
        { type: "user_question", role: "user", content: "计算2+2" },
        { type: "final_answer", role: "assistant", content: "2+2=4" },
      ],
    }]);
    const catalog = path.join(directory, "catalog");
    const args = ["--config", path.join(ROOT, "configs/host.json"), "--config", overlay, "--catalog", catalog];
    const entry = path.join(ROOT, "dist/tests/fixtures/cli.js");
    const env = { ...process.env, EVAL_BASE_URL: "http://127.0.0.1:1/v1" };
    const { stdout } = await exec(process.execPath, [entry, directory, "index", ...args,
      "--dataset", "competitor", "--dataset-name", "竞品对比",
      ...["a_fast", "b_fast"].flatMap((id) => ["--input", `${id}=${config.inputs.versions.find((v) => v.id === id)!.sources[0]!.path}`]),
    ], { env });
    assert.equal(JSON.parse(stdout).valid, 2);
    const { stdout: preflight } = await exec(process.execPath,
      [entry, directory, "preflight", ...args, "--dataset", "competitor"], { env });
    assert.equal(JSON.parse(preflight).comparison_tasks, 1);
    assert.equal(JSON.parse(preflight).cases, 1);
    const output = path.join(directory, "runs");
    await mkdir(path.join(output, "continued"), { recursive: true });
    await writeFile(path.join(output, "continued", "state.json"), "{}");
    await assert.rejects(exec(process.execPath, [entry, directory, "run", ...args,
      "--dataset", "stale", "--run-id", "continued", "--output", output, "--engine", "invalid",
    ], { env }), (error: unknown) => {
      const stderr = (error as { stderr: string }).stderr;
      return stderr.includes("忽略 --dataset stale") && stderr.includes("--engine must be pi or prime");
    }, "resume must use the registered sources instead of requiring the index");
    const errors = [];
    for await (const row of readJsonl(path.join(directory, "log/runtime.log"))) errors.push(row);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as { message: string }).message, "--engine must be pi or prime");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a named dataset supplies its ID as the batch only for records missing batch_id", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    config.inputs.versions = [config.inputs.versions[0]!, config.inputs.versions[2]!];
    config.comparisons = [[config.inputs.versions[0]!.id, config.inputs.versions[1]!.id]];
    const missingBatch = raw();
    delete missingBatch.batch_id;
    for (const version of config.inputs.versions) await writeJsonl(version.sources[0]!.path, [missingBatch]);
    const catalog = path.join(directory, "catalog");
    const index = await indexDataset(config, catalog, "competitor", "竞品对比");
    assert.equal(index.invalid, 0);
    const selected = await selectDataset(config, catalog, "competitor");
    assert.equal(selected.inputs.default_batch_id, "competitor");
    const plan = await buildPlan(selected, undefined, { materializeInputs: false });
    assert.deepEqual(plan.summary.issues, []);
    assert.equal(plan.summary.comparison_tasks, 1);
    assert(Object.hasOwn(plan.summary.by_batch as object, "competitor"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("index errors contain locations rather than raw messages and cannot be selected", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const catalog = path.join(directory, "catalog");
    config.inputs.versions = [config.inputs.versions[0]!, config.inputs.versions[2]!];
    config.comparisons = [[config.inputs.versions[0]!.id, config.inputs.versions[1]!.id]];
    const good = await indexDataset(config, catalog, "dataset", "评测集");
    assert.equal(good.invalid, 0);
    const file = config.inputs.versions[0]!.sources[0]!.path;
    await writeFile(file, JSON.stringify(raw()) + "\n" + JSON.stringify(raw()) + "\n{broken\n");
    const invalid = await indexDataset(config, catalog, "dataset", "评测集");
    assert.equal(invalid.invalid, 2);
    assert.equal((await readInputCatalog<InputDatasetIndex>(catalog, "dataset")).records_file, invalid.records_file);
    await assert.rejects(selectDataset(config, catalog, "dataset"), /无效输入/);
    const rows: { status: string; error_code?: string }[] = [];
    for await (const row of readJsonl(path.join(catalog, "dataset", invalid.records_file))) rows.push(row as typeof rows[number]);
    assert.deepEqual(rows.filter((row) => row.status === "invalid").map((row) => row.error_code),
      ["duplicate_input", "input_json_invalid"]);
    assert(!JSON.stringify(rows).includes("messages"));
    await writeFile(file, JSON.stringify(raw()) + "\n");
    const repaired = await indexDataset(config, catalog, "dataset", "评测集");
    assert.equal((await selectDataset(config, catalog, "dataset")).inputs.versions.length, 2);
    const changedDefault = { ...config, inputs: { ...config.inputs, default_batch_id: "different" } };
    await assert.rejects(selectDataset(changedDefault, catalog, "dataset"), /默认批次已变更/);
    // Byte length is unchanged, but the original business identity has changed.
    await writeFile(file, JSON.stringify(raw("xx")) + "\n");
    await assert.rejects(selectDataset(config, catalog, "dataset"), /来源已变更/);
    await writeFile(file, JSON.stringify(raw()) + "\n");
    await writeFile(file, JSON.stringify(raw()) + "\n" + JSON.stringify(raw("extra")) + "\n");
    await assert.rejects(selectDataset(config, catalog, "dataset"), /来源已变更/);
    await writeFile(file, JSON.stringify(raw()) + "\n");
    await writeFile(path.join(catalog, "dataset", repaired.records_file), "");
    await assert.rejects(selectDataset(config, catalog, "dataset"), /索引记录缺行/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
