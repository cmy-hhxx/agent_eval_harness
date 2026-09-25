import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "#pi-sdk";

test("Pi has no built-in models and registers only the explicit gateway model", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-pi-models-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: path.join(directory, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    assert.deepEqual(runtime.getModels(), []);
    runtime.registerProvider("configured", {
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      models: [
        {
          id: "explicit-model",
          name: "explicit-model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 10000,
          maxTokens: 1000,
        },
      ],
    });
    assert.deepEqual(
      runtime.getModels().map((model) => [model.provider, model.id]),
      [["configured", "explicit-model"]],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
