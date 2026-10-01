import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../../tests/fixtures/services.js";

type Listener = { child: ChildProcess; port: number; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };
const realLsof = spawnSync("sh", ["-c", "command -v lsof"], { encoding: "utf8" }).stdout.trim();
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function listen(ignoreTerm = false, port = 0): Promise<Listener> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
import net from "node:net";
const server = net.createServer();
process.on("SIGTERM", () => { if (!${ignoreTerm}) server.close(() => process.exit(0)); });
server.listen(${port}, "127.0.0.1", () => console.log(server.address().port));
`], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const listeningPort = await new Promise<number>((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Listener exited before readiness: ${stderr}`)));
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\n")) resolve(Number(output.trim()));
    });
  });
  return { child, port: listeningPort, exited };
}

async function stop(listener: Listener) {
  if (listener.child.exitCode === null && listener.child.signalCode === null) listener.child.kill("SIGKILL");
  await listener.exited;
}

async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try { await stat(file); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error(`Startup did not reach build: ${file}`);
}

async function lines(file: string) {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function launch(options: { debug?: boolean; fail?: boolean; setup?: boolean; args?: string[]; listeners?: Listener[]; lsofError?: boolean; onBuild?: () => Promise<Listener> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "eris startup "));
  let running: ChildProcess | undefined;
  try {
    await mkdir(path.join(root, "agent"));
    await mkdir(path.join(root, "bin"));
    await cp(path.join(ROOT, "agent/run.sh"), path.join(root, "agent/run.sh"));
    if (!options.setup) for (const file of [".runtime/pi.json", ".runtime/prime.json", "vendor/pi/packages/coding-agent/dist/index.js", "vendor/prime-agent/packages/coding-agent/dist/index.js"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "{}");
    }
    await writeFile(path.join(root, "bin/npm"), `#!/bin/sh
printf 'npm:%s\\n' "$*" >> "$ERIS_TEST_COMMANDS"
echo 'npm warn Unknown user config "allow-scripts"' >&2
exit 0
`, { mode: 0o755 });
    await writeFile(path.join(root, "bin/node"), `#!/bin/sh
if [ "$1" = --input-type=module ]; then exec ${shellQuote(process.execPath)} "$@"; fi
printf 'node:%s\\n' "$*" >> "$ERIS_TEST_COMMANDS"
case "$1" in
  scripts/*)
    if [ -n "$ERIS_TEST_BUILD_GATE" ]; then
      touch "$ERIS_TEST_BUILD_GATE.started"
      while [ ! -f "$ERIS_TEST_BUILD_GATE.finished" ]; do sleep 0.01; done
    fi
    echo 'bundler asset list'
    echo 'bundler warning' >&2
    if [ "$ERIS_TEST_FAIL" = 1 ]; then echo 'error TS2304: real build failure' >&2; exit 7; fi
    ;;
  *) echo 'Eris: http://127.0.0.1:4190/u/alice/' ;;
esac
`, { mode: 0o755 });
    const commands = path.join(root, "commands.txt");
    const portChecks = path.join(root, "port-checks.txt");
    const ownedPids = path.join(root, "owned-pids.txt");
    const buildGate = path.join(root, "build");
    await writeFile(path.join(root, "bin/lsof"), `#!/bin/sh
printf '%s\\n' "$*" >> "$ERIS_TEST_PORT_CHECKS"
case "$ERIS_TEST_LSOF_MODE" in
  error) echo 'lsof permission failure' >&2; exit 2 ;;
  real)
    output=$("$ERIS_TEST_REAL_LSOF" "$@" 2>&1)
    status=$?
    if [ "$status" != 0 ]; then printf '%s' "$output"; exit "$status"; fi
    printf '%s\\n' "$output" | grep -Fx -f "$ERIS_TEST_OWNED_PIDS"
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    await writeFile(ownedPids, (options.listeners ?? []).map((listener) => listener.child.pid).join("\n"));
    running = spawn("bash", [path.join(root, "agent/run.sh"), ...(options.args ?? ["--port", "4190", "--user", "alice", "--no-open"]), ...(options.debug ? ["--debug"] : [])], {
      cwd: os.tmpdir(),
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, ERIS_TEST_COMMANDS: commands, ERIS_TEST_FAIL: options.fail ? "1" : "0", ERIS_TEST_PORT_CHECKS: portChecks,
        ERIS_TEST_LSOF_MODE: options.lsofError ? "error" : options.listeners || options.onBuild ? "real" : "empty", ERIS_TEST_REAL_LSOF: realLsof,
        ERIS_TEST_OWNED_PIDS: ownedPids, ERIS_TEST_BUILD_GATE: options.onBuild ? buildGate : "" },
    });
    const child = running;
    let stdout = "", stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status, signal) => resolve({ status, signal }));
    }).finally(() => clearTimeout(timer));
    if (options.onBuild) {
      await waitForFile(`${buildGate}.started`);
      const listener = await options.onBuild();
      await writeFile(ownedPids, [...(options.listeners ?? []), listener].map((item) => item.child.pid).join("\n"));
      await writeFile(`${buildGate}.finished`, "ready");
    }
    const result = await exited;
    return { ...result, stdout, stderr, commands: await lines(commands), portChecks: await lines(portChecks) };
  } finally {
    if (running?.exitCode === null && running.signalCode === null) running.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

test("Eris startup keeps successful build diagnostics out of the terminal and forwards launch options", async () => {
  const result = await launch();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert(!/warn|asset list/.test(result.stdout));
  assert(result.stdout.includes("Eris: http://127.0.0.1:4190/u/alice/"));
  assert.deepEqual(result.commands, ["npm:ls --depth=0 --silent", "node:scripts/build-app.mjs", "node:--env-file-if-exists=.env dist/apps/host/src/agent.js --port 4190 --user alice --no-open"]);
});

test("Eris startup preserves build failure output and exit code without launching stale code", async () => {
  const result = await launch({ fail: true });
  assert.equal(result.status, 7);
  assert(result.stderr.includes("error TS2304: real build failure"));
  assert(!result.commands.some((command) => command.includes("dist/apps/host")));
});

test("Eris debug startup shows preparation diagnostics; first setup builds both SDKs once", async () => {
  const result = await launch({ debug: true, setup: true });
  assert.equal(result.status, 0, result.stderr);
  assert(result.stderr.includes("bundler warning"));
  assert.deepEqual(result.commands, ["npm:ls --depth=0 --silent", "node:scripts/bootstrap.mjs", "node:scripts/build.mjs", "node:--env-file-if-exists=.env dist/apps/host/src/agent.js --port 4190 --user alice --no-open --debug"]);
});

test("Eris startup accepts equals port syntax and checks only the final selected port", async () => {
  const result = await launch({ args: ["--port", "4191", "--port=4192", "--no-open"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.portChecks, ["-nP -tiTCP:4192 -sTCP:LISTEN", "-nP -tiTCP:4192 -sTCP:LISTEN"]);
  assert(result.commands.at(-1)?.endsWith("--port 4191 --port=4192 --no-open"));
});

test("Eris startup leaves dynamic ports untouched and validates arguments before any cleanup or build", async () => {
  const dynamic = await launch({ args: ["--port=0", "--no-open"], lsofError: true });
  assert.equal(dynamic.status, 0, dynamic.stderr);
  assert.deepEqual(dynamic.portChecks, []);
  for (const args of [["--port=65536"], ["--port=invalid"], ["--port"], ["--unknown"]]) {
    const result = await launch({ args });
    assert.notEqual(result.status, 0);
    assert.notEqual(result.stderr, "");
    assert.deepEqual(result.portChecks, []);
    assert.deepEqual(result.commands, []);
  }
});

test("Eris startup stops when port inspection fails without building or starting", async () => {
  const result = await launch({ lsofError: true });
  assert.equal(result.status, 2);
  assert(result.stderr.includes("lsof permission failure"));
  assert.deepEqual(result.commands, []);
});

test("Eris startup gracefully stops its selected listener and preserves other ports", { skip: !realLsof }, async () => {
  const target = await listen();
  const other = await listen();
  try {
    const result = await launch({ args: [`--port=${target.port}`, "--no-open"], listeners: [target, other] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(target.child.exitCode, 0);
    assert.deepEqual(await target.exited, { code: 0, signal: null });
    assert(result.stdout.includes(`正在释放 Eris 端口 ${target.port}`));
    assert.equal(other.child.exitCode, null);
    assert.equal(other.child.signalCode, null);
    process.kill(other.child.pid!, 0);
    assert(result.commands.at(-1)?.includes("dist/apps/host/src/agent.js"));
  } finally { await Promise.all([stop(target), stop(other)]); }
});

test("Eris startup kills a selected listener that ignores TERM before launching", { skip: !realLsof }, async () => {
  const target = await listen(true);
  try {
    const result = await launch({ args: ["--port", String(target.port), "--no-open"], listeners: [target], debug: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(target.child.signalCode, "SIGKILL");
    assert.deepEqual(await target.exited, { code: null, signal: "SIGKILL" });
    assert(result.stdout.includes(`正在强制终止旧进程 ${target.child.pid}`));
    assert(result.commands.at(-1)?.includes("dist/apps/host/src/agent.js"));
  } finally { await stop(target); }
});

test("Eris startup checks again after building and clears a new listener", { skip: !realLsof }, async () => {
  const reservation = await listen();
  const port = reservation.port;
  await stop(reservation);
  let target: Listener | undefined;
  try {
    const result = await launch({ args: ["--port", String(port), "--no-open"], onBuild: async () => { target = await listen(false, port); return target; } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(target!.child.exitCode, 0);
    assert.deepEqual(await target!.exited, { code: 0, signal: null });
    assert(result.stdout.indexOf("正在准备 Eris") < result.stdout.indexOf(`正在释放 Eris 端口 ${port}`));
    assert(result.commands.at(-1)?.includes("dist/apps/host/src/agent.js"));
  } finally { if (target) await stop(target); }
});
