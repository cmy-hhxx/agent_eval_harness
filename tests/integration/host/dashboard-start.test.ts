import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exists } from "@eval/data";
import { ROOT } from "../../fixtures/services.js";

test("bash run.sh builds the Host from the repository root and launches the local dashboard", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-dashboard-start-"));
  const bin = path.join(directory, "bin");
  const log = path.join(directory, "commands.txt");
  try {
    await mkdir(bin);
    await writeFile(
      path.join(bin, "npm"),
      '#!/bin/sh\nprintf "%s|%s\\n" "$PWD" "$*" >> "$EVAL_RUN_TEST_LOG"\n',
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [path.join(ROOT, "run.sh")], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EVAL_RUN_TEST_LOG: log },
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(commands, [
      `${ROOT}|run build:app`,
      `${ROOT}|run eval -- dashboard --port 4173 --config configs/host.json` +
        ((await exists(path.join(ROOT, "configs/local/models.json"))) ? " --config configs/local/models.json" : ""),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
