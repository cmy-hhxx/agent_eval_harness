import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { root } from "./lib.mjs";

test("Eris deployment sends secrets only through stdin and distributes isolated code through Git", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-deploy-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin"); await mkdir(bin);
  const captured = path.join(directory, "stdin"), argumentsFile = path.join(directory, "arguments");
  await writeFile(path.join(bin, "ssh"), `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(process.env.ERIS_ARGUMENTS,JSON.stringify(process.argv.slice(2)));let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>fs.writeFileSync(process.env.ERIS_CAPTURE,input,{mode:0o600}));\n`, { mode: 0o755 });
  const config = path.join(directory, "servers.conf");
  await writeFile(config, "[eval_agent_server]\nhost=fixture\nport=3929\nuser=root\nauth=key\nkey=/fixture/key\n");
  const child = spawn(process.execPath, [path.join(root, "scripts/deploy-eris.mjs"), "--config", config, "--branch", "codex/test", "--start"], {
    env: { ...process.env, PATH: bin + ":" + process.env.PATH, ERIS_ADMIN_PASSWORD: "fixture-secret", ERIS_CAPTURE: captured, ERIS_ARGUMENTS: argumentsFile }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, output);
  const script = await readFile(captured, "utf8"), args = await readFile(argumentsFile, "utf8");
  assert(!args.includes("fixture-secret")); assert(!output.includes("fixture-secret"));
  assert(script.includes("export ERIS_ADMIN_PASSWORD='fixture-secret'"));
  assert(script.indexOf("npm run build") < script.indexOf("export ERIS_ADMIN_PASSWORD="));
  assert(script.includes("eris-code")); assert(script.includes("BRANCH='codex/test'"));
  assert(script.includes("git -c credential.helper=")); assert(script.includes("tmux new-session -d -s eris"));
  assert(!/rsync|scp |git bundle|kill |aime-auto/.test(script));
});
