import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root } from "./lib.mjs";

const exec = promisify(execFile),
  temporary = await mkdtemp(path.join(os.tmpdir(), "eval-clean-build-"));
const checkout = path.join(temporary, "checkout"),
  bin = path.join(temporary, "bin");
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: checkout,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        EVAL_BASE_URL: "http://127.0.0.1:1/v1",
        EVAL_API_KEY: "",
        HUSKY: "0",
      },
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")}: ${code}`)),
    );
  });
try {
  await mkdir(checkout);
  await mkdir(bin);
  const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  const deleted = new Set(
    (await exec("git", ["ls-files", "-z", "--deleted"], { cwd: root })).stdout.split("\0"),
  );
  for (const file of new Set(stdout.split("\0").filter(Boolean))) {
    if (deleted.has(file)) continue;
    await mkdir(path.dirname(path.join(checkout, file)), { recursive: true });
    await cp(path.join(root, file), path.join(checkout, file));
  }
  // Share only download caches; never reuse installed packages, builds or virtualenvs.
  await symlink(path.join(root, ".cache"), path.join(checkout, ".cache"));
  for (const [name, target] of [
    ["node", process.execPath],
    ["uv", (await exec("which", ["uv"])).stdout.trim()],
    ["python", path.join(root, ".venv/bin/python")],
    ["python3", path.join(root, ".venv/bin/python")],
  ])
    await symlink(await realpath(target), path.join(bin, name));
  // mise's npm launcher resolves its installation relative to its invocation path.
  const npm = await realpath((await exec("which", ["npm"])).stdout.trim());
  await writeFile(path.join(bin, "npm"), `#!/bin/sh\nexec '${npm.replaceAll("'", "'\\''")}' "$@"\n`, {
    mode: 0o755,
  });
  console.log("Clean checkout with only Node/npm/uv/Python on PATH; no global pi or prime-agent.");
  await run("npm", ["run", "bootstrap"]);
  // Build each adapter independently before the full host is built.
  await run("npm", ["run", "build:pi"]);
  await run("npm", ["run", "build:prime"]);
  await run("npm", ["run", "build:app"]);
  await run("npm", ["run", "doctor"]);
  await run("npm", ["test"]);
  await run("npm", ["run", "test:integration"]);
  console.log("Clean build, isolated adapters, doctor and all TypeScript/SDK tests passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
