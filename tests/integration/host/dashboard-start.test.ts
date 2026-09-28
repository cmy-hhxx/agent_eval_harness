import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../../fixtures/services.js";

async function launch(options: { debug?: boolean; fail?: boolean; setup?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard startup "));
  try {
    await mkdir(path.join(root, "bin"));
    await mkdir(path.join(root, "configs/local"), { recursive: true });
    await cp(path.join(ROOT, "run.sh"), path.join(root, "run.sh"));
    await writeFile(path.join(root, "configs/host.json"), "{}");
    await writeFile(path.join(root, "configs/local/models.json"), "{}");
    if (!options.setup) for (const file of [".runtime/pi.json", ".runtime/prime.json", "vendor/pi/packages/coding-agent/dist/index.js", "vendor/prime-agent/packages/coding-agent/dist/index.js"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "{}");
    }
    await writeFile(path.join(root, "bin/npm"), `#!/bin/sh
printf 'npm:%s\\n' "$*" >> "$DASHBOARD_TEST_COMMANDS"
echo 'npm warn Unknown user config "allow-scripts"' >&2
exit 0
`, { mode: 0o755 });
    await writeFile(path.join(root, "bin/node"), `#!/bin/sh
printf 'node:%s\\n' "$*" >> "$DASHBOARD_TEST_COMMANDS"
case "$1" in
  scripts/*)
    echo 'bundler asset list'
    echo 'bundler warning' >&2
    if [ "$DASHBOARD_TEST_FAIL" = 1 ]; then echo 'error TS2304: real build failure' >&2; exit 7; fi
    ;;
  *) echo 'Dashboard listening at http://127.0.0.1:4181' ;;
esac
`, { mode: 0o755 });
    const commands = path.join(root, "commands.txt");
    const result = spawnSync("bash", [path.join(root, "run.sh"), "--port", "4181", ...(options.debug ? ["--debug"] : [])], {
      cwd: os.tmpdir(), encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, DASHBOARD_TEST_COMMANDS: commands, DASHBOARD_TEST_FAIL: options.fail ? "1" : "0" },
    });
    return { ...result, commands: (await readFile(commands, "utf8")).trim().split("\n") };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("Dashboard startup keeps successful build diagnostics out of the terminal and forwards launch options", async () => {
  const result = await launch();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert(!/warn|asset list/.test(result.stdout));
  assert(result.stdout.includes("Dashboard listening at http://127.0.0.1:4181"));
  assert.deepEqual(result.commands, [
    "npm:ls --depth=0 --silent",
    "node:scripts/build-app.mjs",
    "node:--env-file-if-exists=.env dist/apps/host/src/cli.js dashboard --config configs/host.json --config configs/local/models.json --port 4181",
  ]);
});

test("Dashboard startup preserves build failure output and exit code without launching stale code", async () => {
  const result = await launch({ fail: true });
  assert.equal(result.status, 7);
  assert(result.stderr.includes("error TS2304: real build failure"));
  assert(!result.commands.some((command) => command.includes("dist/apps/host/src/cli.js")));
});

test("Dashboard debug startup shows preparation diagnostics; first setup builds both SDKs once", async () => {
  const result = await launch({ debug: true, setup: true });
  assert.equal(result.status, 0, result.stderr);
  assert(result.stderr.includes("bundler warning"));
  assert.deepEqual(result.commands, [
    "npm:ls --depth=0 --silent",
    "node:scripts/bootstrap.mjs",
    "node:scripts/build.mjs",
    "node:--env-file-if-exists=.env dist/apps/host/src/cli.js dashboard --config configs/host.json --config configs/local/models.json --port 4181",
  ]);
});
