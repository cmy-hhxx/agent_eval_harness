import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./lib.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-deploy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "origin.git"), seed = path.join(directory, "seed");
  const code = path.join(directory, "server code"), runtime = path.join(directory, "runtime");
  const bin = path.join(directory, "bin"), home = path.join(directory, "home");
  await mkdir(bin); await mkdir(home);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    GIT_AUTHOR_NAME: "Deploy test", GIT_AUTHOR_EMAIL: "deploy@example.test",
    GIT_COMMITTER_NAME: "Deploy test", GIT_COMMITTER_EMAIL: "deploy@example.test" };
  delete env.WORKBENCH_ADMIN_PASSWORD;
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(directory, "init", "--bare", "--initial-branch=main", repository);
  git(directory, "clone", repository, seed);
  await mkdir(path.join(seed, "scripts")); await mkdir(path.join(seed, "configs"));
  for (const file of ["scripts/workbench-init.mjs", "configs/host.json", "configs/models.example.json",
    "configs/automations-host.json", "configs/automations.json", "configs/aime-ingest-and-attribute.example.json", "config.example.ini", "mise.toml"])
    await copyFile(path.join(root, file), path.join(seed, file));
  git(seed, "add", "."); git(seed, "commit", "-m", "initial"); git(seed, "push", "origin", "main");
  await writeFile(path.join(bin, "mise"), '#!/bin/bash\ncase "$1" in\ntrust|install) exit 0;;\nexec) shift; exec "$@";;\n*) exit 1;;\nesac\n', { mode: 0o755 });
  const options = ["--repository", pathToFileURL(repository).href, "--code-path", code,
    "--runtime-root", runtime, "--data-root", path.join(directory, "data")];
  const deploy = (extra = [], overrides = {}) => spawnSync(process.execPath,
    [path.join(root, "scripts/deploy-workbench.mjs"), ...options, ...extra],
    { env: { ...env, ...overrides }, encoding: "utf8", timeout: 15_000 });
  return { directory, seed, code, runtime, bin, env, git, deploy };
}

test("server deploy clones and fast-forwards main without SSH or repeating the admin password", async t => {
  const f = await fixture(t);
  let result = f.deploy(["--on-server", "--config", path.join(f.directory, "does-not-exist")],
    { WORKBENCH_ADMIN_PASSWORD: "initial 'password' $(not-executed)" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git(f.code, "branch", "--show-current"), "main");
  const secretFile = path.join(f.runtime, "secrets/workbench.env");
  const secret = await readFile(secretFile, "utf8");
  assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
  const configFile = path.join(f.runtime, "config/host.json");
  await writeFile(configFile, '{"operator":"preserved"}\n');
  await writeFile(path.join(f.seed, "release.txt"), "updated\n");
  f.git(f.seed, "add", "."); f.git(f.seed, "commit", "-m", "update"); f.git(f.seed, "push", "origin", "main");
  result = f.deploy(["--on-server"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git(f.code, "rev-parse", "HEAD"), f.git(f.seed, "rev-parse", "HEAD"));
  assert.equal(await readFile(path.join(f.code, "release.txt"), "utf8"), "updated\n");
  assert.equal(await readFile(secretFile, "utf8"), secret);
  assert.equal(await readFile(configFile, "utf8"), '{"operator":"preserved"}\n');
});

test("deploy refuses modified or diverged server code without discarding it", async t => {
  const f = await fixture(t);
  assert.equal(f.deploy(["--on-server"], { WORKBENCH_ADMIN_PASSWORD: "initial-password" }).status, 0);
  await writeFile(path.join(f.code, "operator.txt"), "server changes\n");
  let result = f.deploy(["--on-server"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /server code changes/);
  assert.equal(await readFile(path.join(f.code, "operator.txt"), "utf8"), "server changes\n");
  f.git(f.code, "add", "."); f.git(f.code, "commit", "-m", "server-only change");
  const head = f.git(f.code, "rev-parse", "HEAD");
  await writeFile(path.join(f.seed, "upstream.txt"), "upstream changes\n");
  f.git(f.seed, "add", "."); f.git(f.seed, "commit", "-m", "upstream-only change"); f.git(f.seed, "push", "origin", "main");
  result = f.deploy(["--on-server"]);
  assert.notEqual(result.status, 0);
  assert.equal(f.git(f.code, "rev-parse", "HEAD"), head);
});

test("local deploy selects eval_agent_server and lets that server fetch the repository", async t => {
  const f = await fixture(t), recorded = path.join(f.directory, "ssh-arguments.json");
  await writeFile(path.join(f.bin, "ssh"), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nwriteFileSync(process.env.TEST_SSH_ARGUMENTS, JSON.stringify(process.argv.slice(2)));\nprocess.exit(spawnSync('bash', ['-s'], { stdio: 'inherit' }).status ?? 1);\n`, { mode: 0o755 });
  const key = path.join(f.directory, "key"), config = path.join(f.directory, "servers.conf");
  await writeFile(key, "test key\n");
  await writeFile(config, "[eval_agent_server]\nhost=eval.example.test\nport=3929\nuser=root\nauth=key\nkey=key\n");
  const result = f.deploy(["--config", config], { WORKBENCH_ADMIN_PASSWORD: "initial-password", TEST_SSH_ARGUMENTS: recorded });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(await readFile(recorded, "utf8"));
  assert.deepEqual(args.slice(-2), ["root@eval.example.test", "bash -s"]);
  assert.equal(args[args.indexOf("-p") + 1], "3929");
  assert.equal(args[args.indexOf("-i") + 1], key);
  assert.equal(f.git(f.code, "rev-parse", "HEAD"), f.git(f.seed, "rev-parse", "HEAD"));
});

test("first initialization still requires an admin password", async t => {
  const f = await fixture(t);
  const result = f.deploy(["--on-server"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_ADMIN_PASSWORD is required/);
  await assert.rejects(stat(path.join(f.runtime, "secrets/workbench.env")), { code: "ENOENT" });
});
