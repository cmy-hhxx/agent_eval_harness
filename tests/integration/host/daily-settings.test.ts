import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { writeJson } from "@eval/data";
import { dailySettingsView, loadDailyHost, readDailySettings, saveDailySettings } from "../../../apps/host/src/daily-settings.js";
import { loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { fixtureConfig } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

test("saved settings remain visible while active executions retain their frozen settings", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const file = path.join(directory, "host.json");
    await writeJson(file, { ...config, evaluatorVersion: "fixture", models: { judge: { channel: "evaluation-gateway", model: "original", thinking: "low" } },
      bindings: Object.fromEntries(["criteria", "attribution", "comparison", "rewrite"].map(stage => [stage, { profile: "judge" }])) });
    const source = { ...await loadAutomationConfig(path.join(ROOT, "configs/automations.json")), hostConfigs: [file],
      stateDirectory: path.join(directory, "state"), publishMongo: false };
    source.runtimeSettings = await readDailySettings(source);
    const saved = await saveDailySettings(source, { engine: "prime", debug: true, execution: { timeoutSeconds: 123 },
      bindings: { attribution: { channel: "evaluation-gateway", model: "next", thinking: "high" } } });
    assert.equal(saved.engine, "prime"); assert.equal(saved.bindings.attribution.model, "next"); assert.equal(saved.execution.timeoutSeconds, 123);
    const active = await loadDailyHost(source);
    assert.equal(active.engine, "pi"); assert.equal(active.host.evaluation.execution.timeoutSeconds, config.execution.timeoutSeconds);
    assert.equal(active.host.models.bindings.attribution.model, undefined);
    assert.equal((await dailySettingsView(source)).bindings.attribution.model, "next");
    const resumed = await loadDailyHost({ ...source, runtimeSettings: await readDailySettings(source) });
    assert.equal(resumed.engine, "prime"); assert.equal(resumed.host.evaluation.execution.timeoutSeconds, 123);
    assert.equal(resumed.host.models.bindings.attribution.model, "next");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
