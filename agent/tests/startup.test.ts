import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../../tests/fixtures/services.js";

async function launch(args: string[], fail = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "eris-startup-"));
  try {
    await mkdir(path.join(root, "agent")); await mkdir(path.join(root, "bin"));
    await mkdir(path.join(root, "node_modules")); await mkdir(path.join(root, ".runtime"));
    await cp(path.join(ROOT, "agent/run.sh"), path.join(root, "agent/run.sh"));
    await writeFile(path.join(root, ".runtime/pi.json"), "{}"); await writeFile(path.join(root, ".runtime/prime.json"), "{}");
    await writeFile(path.join(root, "config.json"), "{}");
    const commands = path.join(root, "commands");
    for (const command of ["node", "npm"]) await writeFile(path.join(root, "bin", command), `#!/bin/sh
printf '%s:%s\\n' '${command}' "$*" >> "$ERIS_COMMANDS"
${command === "npm" && fail ? "exit 7" : "exit 0"}
`, { mode: 0o755 });
    const child = spawn("bash", ["agent/run.sh", ...args], { cwd: root, env: { ...process.env, ERIS_MISE: "1", ERIS_COMMANDS: commands, PATH: path.join(root, "bin") + ":" + process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    return { code, stderr, commands: await readFile(commands, "utf8").catch(() => "") };
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("server startup uses external configuration and never issues process cleanup commands", async () => {
  const result = await launch(["--config", "config.json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.commands, "node:scripts/eris-toolchain.mjs\nnpm:run build:app\nnode:dist/apps/host/src/agent.js --config config.json\n");
  const source = await readFile(path.join(ROOT, "agent/run.sh"), "utf8");
  assert(!/kill|lsof|xdg-open/.test(source));
});
test("invalid configuration arguments and failed builds cannot start stale code", async () => {
  for (const args of [["--port", "5004"], ["--config", "missing.json"], ["--unknown"]]) {
    const result = await launch(args); assert.notEqual(result.code, 0); assert.equal(result.commands, "");
  }
  const failed = await launch(["--config", "config.json"], true);
  assert.equal(failed.code, 7); assert(!failed.commands.includes("dist/apps/host"));
});
