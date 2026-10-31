import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { root } from "./lib.mjs";
import { parseSettings } from "../dist/apps/host/src/settings.js";
import { assistantModelConfiguration } from "../dist/apps/host/src/assistant-models.js";

const codeRoot = "/opt/eval_harness";
const runtimeRoot = "/mnt/fin_bench/sync_datasets/code/1_eval_harnes/runtime";

test("Eris initializes only its own configuration with the DeepSeek V4.1 supported reasoning levels", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-init-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceFile = path.join(directory, "source.ini"), runtime = path.join(directory, "runtime"), collectionsFile = path.join(directory, "collections.json");
  const source = "[channel.evaluation-gateway]\nbase_url=http://fixture/v1\napi_key=fixture-secret\napi=openai-responses\nmodels=previous-model\nthinking=medium\nefforts=low,medium,high\ncontext_window=524288\nmax_output_tokens=32768\n[environment]\nSEARCH_API_KEY=search-fixture\n";
  await writeFile(sourceFile, source);
  await writeFile(collectionsFile, JSON.stringify([{ id: "custom/research", path: "./outputs" }]));
  const child = spawn(process.execPath, [path.join(root, "scripts/eris-init.mjs"), "--runtime-root", runtime, "--source-ini", sourceFile, "--collections-file", collectionsFile], {
    env: { ...process.env, ERIS_ADMIN_PASSWORD: "fixture-password" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, output);
  assert(!/fixture-password|fixture-secret|search-fixture/.test(output));
  assert.equal(await readFile(sourceFile, "utf8"), source);
  assert.equal(JSON.parse(await readFile(path.join(runtime, "config/eris.json"), "utf8")).collectionsFile, collectionsFile);
  const { model, gateways } = assistantModelConfiguration(parseSettings(await readFile(path.join(runtime, "config/eris.ini"), "utf8")));
  assert.equal(model.model, "deepseek-v4.1-flash"); assert.equal(model.thinking, "high");
  assert.deepEqual(gateways[0].efforts, ["low", "high", "xhigh", "max"]);
  assert.equal(model.contextWindow, 524288); assert.equal(model.maxOutputTokens, 32768);
});

test("Eris deployment sends secrets only through stdin and distributes isolated code through Git", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-deploy-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin"); await mkdir(bin);
  const captured = path.join(directory, "stdin"), argumentsFile = path.join(directory, "arguments");
  await writeFile(path.join(bin, "ssh"), `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(process.env.ERIS_ARGUMENTS,JSON.stringify(process.argv.slice(2)));let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>fs.writeFileSync(process.env.ERIS_CAPTURE,input,{mode:0o600}));\n`, { mode: 0o755 });
  const config = path.join(directory, "servers.conf");
  await writeFile(config, "[eval_agent_server]\nhost=fixture\nport=3929\nuser=root\nauth=key\nkey=/fixture/key\n");
  const child = spawn(process.execPath, [path.join(root, "scripts/deploy-eris.mjs"), "--config", config, "--branch", "codex/test", "--start",
    "--source-ini", "/custom/models.ini", "--collections-file", "/custom/collections.json"], {
    env: { ...process.env, PATH: bin + ":" + process.env.PATH, ERIS_ADMIN_PASSWORD: "fixture-secret", ERIS_CAPTURE: captured, ERIS_ARGUMENTS: argumentsFile }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, output);
  const script = await readFile(captured, "utf8"), args = await readFile(argumentsFile, "utf8");
  assert(!args.includes("fixture-secret")); assert(!output.includes("fixture-secret"));
  assert(script.includes("export ERIS_ADMIN_PASSWORD='fixture-secret'"));
  assert(script.indexOf("npm run build") < script.indexOf("export ERIS_ADMIN_PASSWORD="));
  assert(script.includes(`CODE='${codeRoot}/eris-code'`)); assert(script.includes("BRANCH='codex/test'"));
  assert(script.includes(`RUNTIME='${runtimeRoot}'`));
  assert(script.includes("COLLECTIONS='/custom/collections.json'"));
  assert(script.includes('--source-ini "$SOURCE_INI" --collections-file "$COLLECTIONS"'));
  assert(script.includes("git -c credential.helper=")); assert(script.includes("tmux new-session -d -s eris"));
  assert(!/rsync|scp |git bundle|kill |aime-auto/.test(script));
});

test("Eris deployment rejects code outside the deployment root and a separate runtime before SSH", async () => {
  for (const args of [
    ["--code-path", "/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/eris-code"],
    ["--code-path", `${codeRoot}/../other/eris-code`],
    ["--code-path", codeRoot],
    ["--code-path", `${runtimeRoot}/checkout`],
    ["--runtime-root", "/custom/runtime"],
  ]) {
    const child = spawn(process.execPath, [path.join(root, "scripts/deploy-eris.mjs"),
      "--source-ini", "/custom/models.ini", "--collections-file", "/custom/collections.json", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.notEqual(code, 0);
    assert.match(output, /Deploy code in a checkout below|Use --runtime-root/);
    assert(!output.includes("ENOENT"));
  }
});
