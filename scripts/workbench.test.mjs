import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root } from "./lib.mjs";

// Only a copied launcher and recording executables run here. No Workbench or model is started.
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "workbench-shell-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, "server code"), bin = path.join(directory, "bin"), calls = path.join(directory, "calls.jsonl");
  await mkdir(checkout); await mkdir(bin); await writeFile(calls, "");
  await copyFile(path.join(root, "workbench.sh"), path.join(checkout, "workbench.sh"));
  await writeFile(path.join(checkout, "package.json"), '{"engines":{"node":"24.14.1"},"packageManager":"npm@11.11.0"}');
  await writeFile(path.join(checkout, "mise.toml"), 'python = "3.12.12"\nuv = "0.9.27"\n');
  const config = path.join(directory, "runtime config.json"); await writeFile(config, "{}");
  await mkdir(path.join(checkout, "dist/apps/host/src"), { recursive: true });
  await writeFile(path.join(checkout, "dist/apps/host/src/workbench.js"), 'throw new Error("must never execute real Workbench")');
  for (const command of ["node", "npm", "python3", "uv"]) {
    await writeFile(path.join(bin, command), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';
const args = process.argv.slice(2), command = ${JSON.stringify(command)};
appendFileSync(process.env.TEST_CALLS, JSON.stringify({ command, args, cwd: process.cwd() }) + '\\n');
if (command === 'node' && args[0] === '-p') console.log(args[1].includes('engines') || args[1].includes('versions.node') ? '24.14.1' : '11.11.0');
if (command === 'npm' && args[0] === '--version') console.log('11.11.0');
if (command === 'python3') console.log('3.12.12');
if (command === 'uv') console.log('uv 0.9.27 (test)');
`, { mode: 0o755 });
  }
  await writeFile(path.join(bin, "mise"), '#!/bin/bash\ncase "$1" in\nwhich) tool="$2"; [[ "$tool" != python ]] || tool=python3; printf "%s/%s\\n" "$(dirname "$0")" "$tool";;\nexec) shift; exec "$@";;\n*) exit 90;;\nesac\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WORKBENCH_CONFIG: config, TEST_CALLS: calls };
  delete env.WORKBENCH_MISE;
  const run = async (args, overrides = {}) => {
    await writeFile(calls, "");
    const result = spawnSync("bash", [path.join(checkout, "workbench.sh"), ...args], {
      cwd: directory, env: { ...env, ...overrides }, encoding: "utf8", timeout: 10000,
    });
    const recorded = (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { ...result, recorded };
  };
  return { checkout, config, run };
}

test("help and invalid arguments never prepare or start Workbench", async t => {
  const f = await fixture(t);
  for (const args of [["--help"], ["status", "--help"], ["restart"], ["--unknown"], ["--config"], ["start", "--follow"], ["logs", "--lines"]]) {
    const result = await f.run(args, { WORKBENCH_CONFIG: "/missing/config.json" });
    assert.equal(result.status, args.includes("--help") ? 0 : 2, result.stderr);
    assert.deepEqual(result.recorded, []);
  }
});

test("status, stop and logs bypass installation, builds and unrelated toolchains", async t => {
  const f = await fixture(t);
  for (const args of [["status"], ["stop"], ["logs", "--log", "evaluation", "--lines", "20", "--follow"]]) {
    const result = await f.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.recorded, [{ command: "node", cwd: f.checkout,
      args: ["dist/apps/host/src/workbench.js", args[0], "--config", f.config, ...args.slice(1)] }]);
  }
});

test("start works outside the checkout and resolves explicit relative config before changing directory", async t => {
  const f = await fixture(t);
  for (const args of [[], ["start", "--config", "runtime config.json"]]) {
    const result = await f.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.recorded.every(call => call.cwd === f.checkout), true);
    assert.deepEqual(result.recorded.at(-1).args, ["dist/apps/host/src/workbench.js", "start", "--config", f.config]);
    assert.equal(result.recorded.some(call => call.command === "npm" && call.args[0] === "run"), true);
  }
});

test("check validates toolchains without installing dependencies or building", async t => {
  const f = await fixture(t), result = await f.run(["check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.recorded.some(call => call.command === "npm" && call.args[0] === "run"), false);
  assert.deepEqual(result.recorded.at(-1).args, ["dist/apps/host/src/workbench.js", "check", "--config", f.config]);
});

test("missing control build fails without bootstrapping or starting", async t => {
  const f = await fixture(t);
  await rm(path.join(f.checkout, "dist"), { recursive: true });
  const result = await f.run(["status"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /缺少构建产物/);
  assert.deepEqual(result.recorded, []);
});
