import path from "node:path";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const code = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { values } = parseArgs({ options: { "runtime-root": { type: "string" } } });
const runtime = path.resolve(values["runtime-root"] ?? path.join(code, "../runtime"));
const config = path.join(runtime, "config");
const read = file => readFile(file, "utf8").then(JSON.parse);
const optional = file => read(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
const write = async (file, value) => {
  const temporary = file + "." + randomUUID();
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, file);
};
const workbenchFile = path.join(config, "workbench.json"), workbench = await read(workbenchFile);
const aimeFile = path.join(config, "aime-ingest-and-attribute.json");
const aime = await optional(aimeFile);
if (!aime) throw new Error("AIME配置缺失，请先运行workbench:init");
const dataRoot = path.resolve(config, workbench.data.root);
const host = await read(path.join(code, "configs/host.json"));
host.output = { kind: "directory", path: path.join(dataRoot, "0_wencai/eval_output/0_daily_eval") };
host.problemLibrary = { kind: "directory", path: path.join(runtime, "data/problems") };
host.inputs.versions.forEach(version => { version.display_name = version.display_name.replace("B组", "AA组"); });
const hostFile = path.join(config, "daily-host.json");
await write(hostFile, host);
const executionFile = path.join(config, "daily-execution.json");
await write(executionFile, await read(path.join(code, "configs/automations-host.json")));
const old = await optional(path.join(config, "automations.json"));
const wencai = { ...await read(path.join(code, "configs/automations.json")),
  ...(old ? Object.fromEntries(["id", "stateDirectory", "sourceDirectory"].map(key => [key, old[key]])) : {}) };
wencai.hostConfigs = [hostFile, path.join(config, "models.json"), executionFile];
wencai.sourceUrl = `http://${workbench.data.host}:${workbench.data.port}/data/wencai`;
wencai.stateDirectory = path.resolve(config, wencai.stateDirectory);
wencai.sourceDirectory = path.resolve(config, wencai.sourceDirectory);
wencai.publication.logFile = path.join(runtime, "log/comparison-statistics-log.jsonl");
await write(path.join(config, "automations.json"), wencai);
const checkouts = path.join(runtime, "checkouts");
aime.hostConfigs = [hostFile, path.join(code, "configs/answer-review.json"),
  ...aime.hostConfigs.filter(file => !["host.json", "answer-review.json"].includes(path.basename(file)) &&
    path.resolve(config, file) !== hostFile && !path.resolve(config, file).startsWith(checkouts + path.sep))];
aime.archiveDirectory = path.join(dataRoot, "1_aime/1_7z_data/online_data");
aime.inputDirectory = path.join(dataRoot, "1_aime/2_daily_eval_input");
aime.outputDirectory = path.join(dataRoot, "1_aime/eval_output/0_daily_eval");
aime.concurrency = 200;
await write(aimeFile, aime);
const previousFile = path.resolve(config, workbench.runtime.manifest);
const previous = await optional(previousFile);
const sources = [
  { name: "问财日常四路", config: "automations.json", workflow: "comparison" },
  { name: "AIME 日常全量", config: "aime-ingest-and-attribute.json", workflow: "answer-review" },
  ...(previous?.sources ?? []).filter(source => !["automations.json", "aime-ingest-and-attribute.json"].includes(path.basename(source.config))),
];
const manifest = path.join(config, "daily.manifest.json");
await write(manifest, { sources });
if (workbench.runtime.schedulingFile) {
  const schedulingFile = path.resolve(config, workbench.runtime.schedulingFile);
  const scheduling = await optional(schedulingFile) ?? { sources: {} };
  scheduling.sources[wencai.id] = { concurrency: 32 };
  scheduling.sources.aime = { concurrency: 200 };
  await write(schedulingFile, scheduling);
}
workbench.runtime.manifest = manifest;
workbench.runtime.hostConfigs = wencai.hostConfigs;
// AIME's current gateway declares the selected Flash model; secrets stay in this file.
workbench.runtime.evalConfigFile = path.resolve(config, aime.settingsFile);
await write(workbenchFile, workbench);
console.log(JSON.stringify({ workbench: workbenchFile, manifest, sources: sources.map(source => source.name), evaluatorVersion: host.evaluatorVersion }));
