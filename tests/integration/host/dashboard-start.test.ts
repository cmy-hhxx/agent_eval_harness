import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../../fixtures/services.js";

async function launch(options: { debug?: boolean; fail?: boolean; setup?: boolean; args?: string[]; listener?: "dashboard" | "absolute-dashboard" | "other" | "other-repository" | "host" | "worker" } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "dashboard startup ")));
  let oldProcess: ReturnType<typeof spawn> | undefined;
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
  *)
    if [ -n "$DASHBOARD_TEST_PID" ] && kill -0 "$DASHBOARD_TEST_PID" 2>/dev/null; then echo 'listen EADDRINUSE' >&2; exit 98; fi
    echo 'Dashboard listening at http://127.0.0.1:4181'
    ;;
esac
`, { mode: 0o755 });
    const commands = path.join(root, "commands.txt");
    await writeFile(commands, "");
    if (options.listener) {
      oldProcess = spawn(process.execPath, ["--input-type=module", "-e", `
        import { appendFileSync } from "node:fs";
        process.on("SIGTERM", () => { appendFileSync(process.env.DASHBOARD_TEST_COMMANDS, "old-process:stopped\\n"); process.exit(0); });
        process.stdout.write("ready\\n");
        setInterval(() => {}, 1000);
      `], { cwd: root, env: { ...process.env, DASHBOARD_TEST_COMMANDS: commands }, stdio: ["ignore", "pipe", "pipe"] });
      await new Promise<void>((resolve, reject) => { oldProcess!.stdout!.once("data", () => resolve()); oldProcess!.once("error", reject); });
    }
    await writeFile(path.join(root, "bin/lsof"), `#!/bin/sh
printf 'lsof:%s\\n' "$*" >> "$DASHBOARD_TEST_COMMANDS"
[ -n "$DASHBOARD_TEST_PID" ] && kill -0 "$DASHBOARD_TEST_PID" 2>/dev/null || exit 1
case "$*" in
  *'-d cwd'*) printf 'p%s\\nn%s\\n' "$DASHBOARD_TEST_PID" "$DASHBOARD_TEST_CWD" ;;
  *) printf '%s\\n' "$DASHBOARD_TEST_PID" ;;
esac
`, { mode: 0o755 });
    await writeFile(path.join(root, "bin/ps"), `#!/bin/sh
[ -n "$DASHBOARD_TEST_PID" ] && kill -0 "$DASHBOARD_TEST_PID" 2>/dev/null || exit 1
printf '%s\\n' "$DASHBOARD_TEST_PROCESS"
`, { mode: 0o755 });
    const processCommand = options.listener === "other" ? "python -m http.server 4181"
      : options.listener === "host" ? "node dist/apps/host/src/cli.js run --run-id active-evaluation"
      : options.listener === "worker" ? "node dist/apps/worker/src/cli.js --port 4181"
      : `node --env-file-if-exists=.env ${options.listener === "absolute-dashboard" ? root + "/" : ""}dist/apps/host/src/cli.js dashboard --port 4181`;
    let result: { status: number; stdout: string; stderr: string };
    try {
      const value = await promisify(execFile)("bash", [path.join(root, "run.sh"), ...(options.args ?? ["--port", "4181"]), ...(options.debug ? ["--debug"] : [])], {
        cwd: os.tmpdir(), encoding: "utf8", timeout: 10000,
        env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, DASHBOARD_TEST_COMMANDS: commands,
          DASHBOARD_TEST_FAIL: options.fail ? "1" : "0", DASHBOARD_TEST_PID: oldProcess?.pid ? String(oldProcess.pid) : "",
          DASHBOARD_TEST_CWD: options.listener === "other-repository" ? path.join(root, "another checkout") : root,
          DASHBOARD_TEST_PROCESS: processCommand },
      });
      result = { status: 0, stdout: value.stdout, stderr: value.stderr };
    } catch (error) {
      const value = error as { code: number; stdout: string; stderr: string };
      result = { status: value.code, stdout: value.stdout, stderr: value.stderr };
    }
    return { ...result, oldStopped: oldProcess ? oldProcess.exitCode !== null : false,
      commands: (await readFile(commands, "utf8")).trim().split("\n").filter(Boolean) };
  } finally {
    if (oldProcess && oldProcess.exitCode === null) oldProcess.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

test("Dashboard startup keeps successful build diagnostics out of the terminal and forwards launch options", async () => {
  const result = await launch();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert(!/warn|asset list/.test(result.stdout));
  assert(result.stdout.includes("Dashboard listening at http://127.0.0.1:4181"));
  assert.deepEqual(result.commands, [
    "lsof:-nP -t -iTCP:4181 -sTCP:LISTEN",
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
    "lsof:-nP -t -iTCP:4181 -sTCP:LISTEN",
    "npm:ls --depth=0 --silent",
    "node:scripts/bootstrap.mjs",
    "node:scripts/build.mjs",
    "node:--env-file-if-exists=.env dist/apps/host/src/cli.js dashboard --config configs/host.json --config configs/local/models.json --port 4181",
  ]);
});

test("Dashboard restart stops this repository's old dashboard before rebuilding", async () => {
  for (const listener of ["dashboard", "absolute-dashboard"] as const) {
    const result = await launch({ listener });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.oldStopped, true, "the old dashboard must exit before the new launch");
    assert(result.commands.indexOf("old-process:stopped") < result.commands.indexOf("node:scripts/build-app.mjs"));
    assert(result.stdout.includes("正在停止旧看板"));
  }
});

test("Dashboard startup rejects invalid ports before stopping processes or building", async () => {
  for (const args of [["--port"], ["--port", "0"], ["--port=65536"], ["--port=invalid"]]) {
    const result = await launch({ args, listener: "dashboard" });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.oldStopped, false);
    assert.deepEqual(result.commands, []);
  }
});

test("Dashboard restart keeps other listeners and evaluation processes alive", async () => {
  for (const listener of ["other", "other-repository", "host", "worker"] as const) {
    const result = await launch({ listener });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.oldStopped, false, `${listener} must remain alive`);
    assert(result.stderr.includes("不是当前项目的看板"));
    assert(!result.commands.some((command) => command.startsWith("node:") || command.startsWith("npm:")), "an occupied port must be checked before preparation");
  }
});

test("Dashboard restart inspects the default port and both explicit port forms", async () => {
  for (const [args, port] of [[[], "4173"], [["--port=4199"], "4199"], [["--port", "4198"], "4198"]] as const) {
    const result = await launch({ args: [...args] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.commands[0], `lsof:-nP -t -iTCP:${port} -sTCP:LISTEN`);
    assert(result.commands.at(-1)!.endsWith(args.join(" ")));
  }
});
