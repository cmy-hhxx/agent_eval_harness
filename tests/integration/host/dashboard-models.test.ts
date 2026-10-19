import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { json, listen } from "@eval/runtime/http";
import { discoverDashboardModels, type DashboardModelFailure } from "../../../apps/host/src/dashboard-models.js";
import { startDashboard } from "../../../apps/host/src/dashboard.js";
import { ROOT } from "../../fixtures/services.js";

test("evaluation catalog uses static declarations and isolates failed channels without credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-model-catalog-")), previous = process.env.EVAL_CONFIG_FILE;
  const requests: string[] = [];
  const gateway = await listen(async (req, res) => {
    requests.push(req.url!);
    if (req.url === "/healthy/models") return json(res, { data: [{ id: "dynamic-model" }] });
    return json(res, { error: "fixture-secret" }, 503);
  });
  const file = path.join(directory, "config.ini");
  await writeFile(file, `[channel.evaluation-gateway]\nname=Static\nbase_url=${gateway.url}/static\napi_key=fixture-secret\nmodels=deepseek-local,plain-model\nmodel=deepseek-local\n[channel.healthy]\nname=Healthy\nbase_url=${gateway.url}/healthy\napi_key=fixture-secret\n[channel.broken]\nname=Broken\nbase_url=${gateway.url}/broken\napi_key=fixture-secret\n[channel.eris-only]\nbase_url=${gateway.url}/eris\napi_key=fixture-secret\napi=openai-completions\n`);
  process.env.EVAL_CONFIG_FILE = file;
  let failures: DashboardModelFailure[] = [];
  try {
    const models = await discoverDashboardModels(value => { failures = value; });
    assert.deepEqual(models.map(model => [model.channel, model.id]), [
      ["evaluation-gateway", "deepseek-local"], ["evaluation-gateway", "plain-model"], ["healthy", "dynamic-model"],
    ]);
    assert.deepEqual(requests.sort(), ["/broken/models", "/healthy/models"]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].channel, "broken");
    assert.match(failures[0].message, /503/);
    assert(!JSON.stringify({ models, failures }).includes("fixture-secret"));
    const dashboard = await startDashboard({ configPaths: [path.join(ROOT, "configs/host.json")], port: 0 });
    try {
      const payload = await (await fetch(dashboard.url + "/api/dashboard/config")).json();
      assert.equal(payload.model_catalog.length, 3);
      assert.equal(payload.model_catalog_failures[0].channel, "broken");
      assert.equal(payload.model_catalog_error, undefined);
      assert(!JSON.stringify(payload).includes("fixture-secret"));
    } finally { await dashboard.close(); }
  } finally {
    if (previous === undefined) delete process.env.EVAL_CONFIG_FILE; else process.env.EVAL_CONFIG_FILE = previous;
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});
