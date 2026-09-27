import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../../tests/fixtures/services.js";

async function launch(options: { debug?: boolean; fail?: boolean; setup?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "eris startup "));
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
case "$*" in
  'run build:app') exec node scripts/build-app.mjs ;;
  'run bootstrap') exec node scripts/bootstrap.mjs ;;
  'run build') exec node scripts/build.mjs ;;
esac
exit 0
`, { mode: 0o755 });
    await writeFile(path.join(root, "bin/node"), `#!/bin/sh
printf 'node:%s\\n' "$*" >> "$ERIS_TEST_COMMANDS"
case "$1" in
  scripts/*)
    echo 'bundler asset list'
    echo 'bundler warning' >&2
    if [ "$ERIS_TEST_FAIL" = 1 ]; then echo 'error TS2304: real build failure' >&2; exit 7; fi
    ;;
  *) echo 'Eris: http://127.0.0.1:4190/u/alice/' ;;
esac
`, { mode: 0o755 });
    const commands = path.join(root, "commands.txt");
    const result = spawnSync("bash", [path.join(root, "agent/run.sh"), "--port", "4190", "--user", "alice", "--no-open", ...(options.debug ? ["--debug"] : [])], {
      cwd: os.tmpdir(), encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, ERIS_TEST_COMMANDS: commands, ERIS_TEST_FAIL: options.fail ? "1" : "0" },
    });
    return { ...result, commands: (await readFile(commands, "utf8")).trim().split("\n") };
  } finally { await rm(root, { recursive: true, force: true }); }
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
