import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("daily configuration preserves AIME progress and model overlays while enabling both sources", async () => {
  const runtime = await mkdtemp(path.join(tmpdir(), "daily-config-")), config = path.join(runtime, "config");
  const write = (name, value) => writeFile(path.join(config, name), JSON.stringify(value));
  const read = name => readFile(path.join(config, name), "utf8").then(JSON.parse);
  try {
    await mkdir(config);
    const stateDirectory = path.join(runtime, "aime-state");
    await write("workbench.json", { data: { root: path.join(runtime, "data"), host: "127.0.0.1", port: 8081 },
      runtime: { manifest: "special.manifest.json", hostConfigs: ["old-host.json"], evalConfigFile: "old.ini", schedulingFile: "scheduling.json" } });
    await write("scheduling.json", { sources: { existing: { concurrency: 2 }, special: { concurrency: 3 } } });
    await write("special.manifest.json", { sources: [{ name: "专项", config: "special.json" }] });
    await write("automations.json", { id: "existing", runPrefix: "daily-", stateDirectory: "../wencai-state", sourceDirectory: "../sources" });
    await write("aime-ingest-and-attribute.json", { stateDirectory, settingsFile: "gateway.ini", concurrency: 100,
      hostConfigs: ["/old/checkout/configs/host.json", "aime-current.json"] });
    const run = () => execFileSync(process.execPath, ["scripts/configure-daily-workbench.mjs", "--runtime-root", runtime]);
    run();
    const workbench = await read("workbench.json"), aime = await read("aime-ingest-and-attribute.json"), wencai = await read("automations.json");
    assert.equal(aime.stateDirectory, stateDirectory);
    assert.equal(aime.concurrency, 64);
    assert.deepEqual(aime.hostConfigs, [path.join(config, "daily-host.json"), "aime-current.json"]);
    assert.equal(wencai.id, "existing"); assert.equal(wencai.fromDate, null); assert.equal(wencai.dailyComparisonLimitPerTier, null);
    assert.equal(wencai.publishStatisticsLog, false); assert.equal(wencai.publishMongo, true); assert.equal(wencai.autoClean, true);
    assert.equal(workbench.runtime.evalConfigFile, path.join(config, "gateway.ini"));
    assert.deepEqual((await read("scheduling.json")).sources, { existing: { concurrency: 32 }, special: { concurrency: 3 }, aime: { concurrency: 64 } });
    assert.deepEqual((await read("daily.manifest.json")).sources.map(source => source.name), ["问财日常四路", "AIME 日常全量", "专项"]);
    run(); assert.deepEqual(await read("aime-ingest-and-attribute.json"), aime);
    assert.equal((await read("daily.manifest.json")).sources.length, 3);
  } finally { await rm(runtime, { recursive: true, force: true }); }
});
