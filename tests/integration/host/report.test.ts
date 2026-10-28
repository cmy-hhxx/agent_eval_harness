import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { writeJson } from "@eval/data";
import { reportRun } from "@eval/workflows/comparison";
import { validateRun } from "../../fixtures/services.js";
import { fakeEvaluatorVersion, fixtureConfig } from "../../fixtures/comparison.js";

test("report and validate reject unsupported run formats without a compatibility path", async () => {
  const { directory } = await fixtureConfig();
  try {
    for (const manifest of [{}, { format: "unsupported" }]) {
      await writeJson(path.join(directory, "state.json"), manifest);
      await assert.rejects(reportRun(directory), /不支持此运行格式/);
      await assert.rejects(validateRun(directory), /不支持此运行格式/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("debug report requires the run's own schema snapshot", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    await writeJson(path.join(directory, "state.json"), {
      format: "evaluation-run",
      debug: true,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      inputs: {},
      preflight: {},
      tasks: {},
      usage: {},
      recordedAttempts: 0,
    });
    await assert.rejects(reportRun(directory), /ENOENT.*output_schema\.json/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
