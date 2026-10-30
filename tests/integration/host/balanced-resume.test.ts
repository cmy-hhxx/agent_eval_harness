import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type { PlannedTask } from "@eval/contracts";
import { createBalancedModels } from "../../../apps/host/src/balanced-models.js";
import { fixtureConfig } from "../../fixtures/comparison.js";

test("restored task routes do not consume new-task weights and respect the current channel pool", async () => {
  const { directory, models } = await fixtureConfig();
  const previousKey = process.env.BALANCED_RESUME_TEST_KEY;
  models.channels["evaluation-gateway"].trafficWeight = 6;
  models.channels.openai = { ...models.channels["evaluation-gateway"], provider: "openai",
    baseUrl: "https://balanced.example/v1", apiKeyEnv: "BALANCED_RESUME_TEST_KEY", trafficWeight: 4 };
  process.env.BALANCED_RESUME_TEST_KEY = "balanced-resume-test-secret";
  const task = (id: string) => ({ id, stage: "attribution-compact" } as PlannedTask);
  try {
    const exhausted = new Set<string>(), routing = createBalancedModels(models, undefined, exhausted);
    for (let index = 0; index < 7; index++) {
      const restored = task(`restored-${index}`);
      assert.equal(routing.modelForTask(restored, "openai").provider, "openai");
      assert.equal(routing.modelForTask(restored, "evaluation-gateway").provider, "openai", "an existing assignment takes priority over a stale hint");
    }
    const counts = new Map<string, number>();
    for (let index = 0; index < 100; index++) {
      const model = routing.modelForTask(task(`new-${index}`));
      counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
      if ((index + 1) % 10 === 0) {
        assert.equal(counts.get("evaluation-gateway"), (index + 1) * 0.6);
        assert.equal(counts.get("openai"), (index + 1) * 0.4);
      }
    }
    const restored = task("restored-0"), oldModel = routing.modelForTask(restored);
    assert.equal(routing.onModelQuotaExhausted(oldModel, restored), true);
    assert.equal(routing.modelForTask(restored, "openai").provider, "evaluation-gateway", "an exhausted saved channel cannot be restored");
    assert.equal(routing.modelForTask(task("after-exhaustion"), "openai").provider, "evaluation-gateway");
    const removed = createBalancedModels(models, ["evaluation-gateway"]);
    assert.equal(removed.modelForTask(task("removed-channel"), "openai").provider, "evaluation-gateway");
  } finally {
    if (previousKey === undefined) delete process.env.BALANCED_RESUME_TEST_KEY;
    else process.env.BALANCED_RESUME_TEST_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});
