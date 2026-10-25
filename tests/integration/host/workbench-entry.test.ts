import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Execute the entry point with every listener, service and Python process replaced.
// This verifies real signal/EOF wiring without opening Workbench or contacting a model.
const harness = String.raw`
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const [entry, directory, stage, dataModule] = process.argv.slice(2), calls = [];
process.on('exit', () => writeFileSync(path.join(directory, 'calls.json'), JSON.stringify(calls)));
const file = path.join(directory, 'workbench.json');
const config = { file, publicOrigin: 'http://example.test', secretsFile: file, listen: { host: '127.0.0.1', port: 5001 },
  data: { root: directory, host: '127.0.0.1', port: 8081, stateRoot: directory, pythonPackages: path.join(directory, 'python') },
  runtime: { configDirectory: directory, manifest: file, evalConfigFile: file, hostConfigs: [], instanceLockDirectory: directory,
    logDirectory: directory, logLockDirectory: directory, automationPort: 4174, runsPort: 4173 },
  restart: { limit: 1 }, shutdownTimeoutMs: 200 };
const replace = (name, exports) => mock.module(new URL(name, entry).href, { namedExports: exports });
replace('workbench-config.js', { loadWorkbenchConfig: async () => config });
replace('workbench-auth.js', { loadWorkbenchSecrets: async () => ({ relayToken: 'fixture' }) });
replace('settings.js', { readSettings: async () => ({ channels: { fixture: {} } }), applySettings: () => {}, configurationSecrets: () => [] });
replace('config.js', { loadConfig: async () => ({ models: { bindings: {}, models: {} } }) });
replace('workbench-access.js', { createWorkbenchAccess: () => async () => false });
replace('workbench-control.js', { openWorkbenchControl: async () => async () => { calls.push('closeControl'); },
  stopWorkbench: async () => {}, workbenchStatus: async () => {}, workbenchLogs: async () => {} });
replace('workbench-services.js', {
  signalWorkbenchChild: () => { calls.push('killPreparation'); },
  WorkbenchServices: class {
    health = { data: true, automation: true, runs: true };
    failed = new Promise(() => {});
    async start() { calls.push('startServices'); }
    async stop() { calls.push('stopServices'); }
  }
});
mock.module(dataModule, { namedExports: {
  createFileLogger: () => ({ initialize: async () => {}, error: async () => {}, event: async name => {
    if (name === 'workbench_ready') process.stdout.write('STAGE_READY\n');
  } }), runLock: async () => async () => { calls.push('release'); }
} });
class FakeServer extends EventEmitter {
  listen(...args) {
    queueMicrotask(() => { this.emit('listening'); if (typeof args.at(-1) === 'function') args.at(-1)(); });
    return this;
  }
  close(callback) { this.emit('close'); callback?.(); }
  closeAllConnections() { calls.push('closeConnections'); }
}
mock.module('node:net', { defaultExport: { createServer: () => new FakeServer() } });
mock.module('node:http', { defaultExport: { createServer: () => { calls.push('createGateway'); return new FakeServer(); } } });
mock.module('node:child_process', { namedExports: { spawn: (command, args, options) => {
  if (command !== 'python3') throw new Error('unexpected process launch');
  const child = new EventEmitter();
  options.signal.addEventListener('abort', () => child.emit('error', new Error('preparation aborted')), { once: true });
  if (stage === 'preparing') process.stdout.write('STAGE_PREPARING\n');
  else queueMicrotask(() => child.emit('exit', 0));
  return child;
} } });
process.env.AUTOMATIONS_MONGODB_URI = 'mongodb://unused';
process.argv = [process.execPath, entry, stage === 'check' ? 'check' : 'start', '--config', file];
await import(entry);
`;

for (const [stage, signal] of [["preparing", "SIGTERM"], ["preparing", "EOF"], ["ready", "SIGINT"],
  ["ready", "SIGTERM"], ["ready", "SIGHUP"], ["ready", "EOF"], ["ready", "BROKEN_OUTPUT"], ["check", "NONE"]] as const) {
  test(`foreground entry cleans up on ${signal} while ${stage}, with all services mocked`, { timeout: 10000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "workbench-entry-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, "python"));
    await writeFile(path.join(directory, "workbench.json"), "{}");
    const script = path.join(directory, "harness.mjs"); await writeFile(script, harness);
    const entry = new URL("../../../apps/host/src/workbench.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--experimental-test-module-mocks", script, entry, directory, stage,
      fileURLToPath(import.meta.resolve("@eval/data"))], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let output = "", error = "", sent = false;
    child.stdout.on("data", chunk => {
      output += chunk;
      if (!sent && output.includes(`STAGE_${stage.toUpperCase()}`)) {
        sent = true;
        if (signal === "BROKEN_OUTPUT") { child.stdout.destroy(); child.stdin.end(); }
        else if (signal === "EOF") child.stdin.end(); else if (signal !== "NONE") child.kill(signal);
      }
    });
    child.stderr.on("data", chunk => { error += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, error); assert.equal(sent, stage !== "check", output + error);
    const calls = JSON.parse(await readFile(path.join(directory, "calls.json"), "utf8")) as string[];
    assert.equal(calls.includes("startServices"), stage === "ready");
    assert.equal(calls.includes("createGateway"), stage === "ready");
    assert.equal(calls.includes("stopServices"), stage !== "check");
    if (stage === "check") assert.deepEqual(calls, ["killPreparation"]);
    else assert.deepEqual(calls.slice(-2), ["closeControl", "release"]);
  });
}
