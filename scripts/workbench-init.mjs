import { randomBytes, scrypt } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const args = parseArgs({ options: {
  "runtime-root": { type: "string" }, "data-root": { type: "string", default: "/mnt/fin_bench/eval_data" },
  "admin-user": { type: "string", default: "cmy" },
} });
const runtime = path.resolve(args.values["runtime-root"] || path.join(root, "../runtime"));
const dataRoot = path.resolve(args.values["data-root"]);
const adminUser = args.values["admin-user"];
const adminPassword = process.env.WORKBENCH_ADMIN_PASSWORD;
if (!adminPassword) throw new Error("WORKBENCH_ADMIN_PASSWORD is required to initialize the admin login");
const directories = ["config", "data/problems", "data/sources/automations/remote-evaluation", "state/automations/remote-evaluation",
  "state/data-service", "state/log-writer", "state/workbench", "log", "python-packages", "secrets"];
for (const directory of directories) await mkdir(path.join(runtime, directory), { recursive: true });
for (const source of ["0_wencai", "1_aime", "2_ifind"])
  for (const category of ["0_daily_eval", "1_task_eval", "test_eval"])
    await mkdir(path.join(dataRoot, source, "eval_output", category), { recursive: true });

async function exists(file) { return access(file).then(() => true, () => false); }
async function writeOnce(file, value, mode) {
  if (await exists(file)) { console.log(`保留 ${file}`); return; }
  await writeFile(file, value, { mode });
  console.log(`创建 ${file}`);
}
async function copyOnce(file, source) {
  if (await exists(file)) { console.log(`保留 ${file}`); return; }
  await copyFile(source, file); console.log(`创建 ${file}`);
}

const host = JSON.parse(await readFile(path.join(root, "configs/host.json"), "utf8"));
host.output = { kind: "directory", path: path.join(dataRoot, "0_wencai/eval_output/0_daily_eval") };
host.problemLibrary = { kind: "directory", path: path.join(runtime, "data/problems") };
await writeOnce(path.join(runtime, "config/host.json"), JSON.stringify(host, null, 2) + "\n");
await writeOnce(path.join(runtime, "config/test-eval.json"), JSON.stringify({ output: {
  kind: "directory", path: path.join(dataRoot, "0_wencai/eval_output/test_eval"),
} }, null, 2) + "\n");
await copyOnce(path.join(runtime, "config/models.json"),
  path.join(root, (await exists(path.join(root, "configs/local/models.json"))) ? "configs/local/models.json" : "configs/models.example.json"));
await copyOnce(path.join(runtime, "config/automations-host.json"), path.join(root, "configs/automations-host.json"));

const automation = JSON.parse(await readFile(path.join(root, "configs/automations.json"), "utf8"));
automation.sourceUrl = "http://127.0.0.1:8081/data/wencai";
automation.hostConfigs = [path.join(runtime, "config/host.json"), path.join(runtime, "config/models.json"), path.join(runtime, "config/automations-host.json")];
automation.stateDirectory = path.join(runtime, "state/automations/remote-evaluation");
automation.sourceDirectory = path.join(runtime, "data/sources/automations/remote-evaluation");
automation.publication = { ...automation.publication, logFile: path.join(runtime, "log/comparison-statistics-log.jsonl") };
await writeOnce(path.join(runtime, "config/automations.json"), JSON.stringify(automation, null, 2) + "\n");

let example = await readFile(path.join(root, "config.example.ini"), "utf8");
example = example.replace(/^AUTOMATIONS_MONGODB_URI\s*=.*$/m, "AUTOMATIONS_MONGODB_URI = mongodb://interactive-q1qu5v9oqj3n:5000");
await writeOnce(path.join(runtime, "config/config.ini"), example, 0o600);

const secretFile = path.join(runtime, "secrets/workbench.env");
if (!(await exists(secretFile))) {
  const salt = randomBytes(16), hash = await promisify(scrypt)(adminPassword, salt, 64);
  const relayToken = randomBytes(32).toString("base64url");
  await writeFile(secretFile, [
    `WORKBENCH_ADMIN_USER=${adminUser}`,
    `WORKBENCH_PASSWORD_HASH=scrypt$${salt.toString("hex")}$${hash.toString("hex")}`,
    `WORKBENCH_RELAY_TOKEN=${relayToken}`,
    "",
  ].join("\n"), { mode: 0o600 });
  console.log(`创建 ${secretFile}`);
} else console.log(`保留 ${secretFile}`);

const workbench = {
  publicOrigin: "http://117.50.195.94:3309",
  listen: { host: "0.0.0.0", port: 5001 },
  secretsFile: path.join(runtime, "secrets/workbench.env"),
  data: { host: "127.0.0.1", port: 8081, root: dataRoot, stateRoot: path.join(runtime, "state/data-service"),
    pythonPackages: path.join(runtime, "python-packages") },
  runtime: {
    automationPort: 4174,
    runsPort: 4173,
    configDirectory: path.join(runtime, "config"),
    evalConfigFile: path.join(runtime, "config/config.ini"),
    manifest: path.join(root, "configs/automations.manifest.json"),
    schedulingFile: path.join(runtime, "state/automations/scheduling.json"),
    statisticsDeliveryFile: path.join(runtime, "state/automations/statistics-delivery.json"),
    hostConfigs: [path.join(runtime, "config/host.json"), path.join(runtime, "config/models.json")],
    logDirectory: path.join(runtime, "log"),
    logLockDirectory: path.join(runtime, "state/log-writer"),
    instanceLockDirectory: path.join(runtime, "state/workbench"),
  },
  restart: { limit: 5, windowMs: 300_000, baseDelayMs: 1_000, maxDelayMs: 16_000 },
  shutdownTimeoutMs: 90_000,
};
await writeOnce(path.join(runtime, "config/workbench.json"), JSON.stringify(workbench, null, 2) + "\n");
console.log(`工作台运行目录：${runtime}`);
