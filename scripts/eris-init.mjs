import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { AssistantAccounts } from "../dist/packages/data/src/index.js";

const { values } = parseArgs({ options: { "runtime-root": { type: "string" }, "source-ini": { type: "string" }, "data-root": { type: "string", default: "/mnt/fin_bench/eval_data" } } });
if (!values["runtime-root"] || !values["source-ini"]) throw new Error("Provide --runtime-root and --source-ini");
const runtime = path.resolve(values["runtime-root"]), configDirectory = path.join(runtime, "config");
await mkdir(configDirectory, { recursive: true });
async function writeOnce(file, content, mode) {
  try { await writeFile(file, content, { flag: "wx", mode }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
const source = await readFile(values["source-ini"], "utf8");
const sections = [...source.matchAll(/^\[([^\]]+)\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)];
const gateway = sections.find(row => row[1] === "channel.evaluation-gateway");
if (!gateway) throw new Error("Source INI has no evaluation-gateway channel");
const environment = sections.find(row => row[1] === "environment")?.[2] ?? "";
const search = environment.split(/\r?\n/).filter(line => /^SEARCH_API_KEY\s*=/.test(line)).join("\n");
await writeOnce(path.join(configDirectory, "eris.ini"), `[channel.evaluation-gateway]\n${gateway[2].replace(/^(?:models?|thinking|efforts)\s*=.*$/gm, "")}\nmodel = deepseek-v4.1-flash\nmodels = deepseek-v4.1-flash\nthinking = high\nefforts = low,high,xhigh,max\n[agent]\nchannel = evaluation-gateway\nmodel = deepseek-v4.1-flash\n[environment]\n${search}\n`, 0o600);
await writeOnce(path.join(configDirectory, "eris.json"), JSON.stringify({
  runtimeRoot: runtime, dataRoot: path.resolve(values["data-root"]), evalConfigFile: path.join(configDirectory, "eris.ini"),
  publicOrigin: "http://117.50.195.94:3928", listen: { host: "0.0.0.0", port: 5004 },
}, null, 2) + "\n", 0o600);
const password = process.env.ERIS_ADMIN_PASSWORD; delete process.env.ERIS_ADMIN_PASSWORD;
await new AssistantAccounts(path.join(runtime, "secrets/eris")).initialize("cmy", password);
console.log("Eris 配置与账号已准备；已有配置保持不变。");
