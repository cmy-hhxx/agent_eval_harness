import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const mise = await readFile(path.join(root, "mise.toml"), "utf8");
const pinned = name => { const match = mise.match(new RegExp(`^${name} = "([^"]+)"`, "m")); if (!match) throw new Error(`Missing ${name} toolchain pin`); return match[1]; };
const version = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
for (const [name, expected, actual] of [
  ["Node", manifest.engines.node, process.versions.node],
  ["npm", manifest.packageManager.split("@")[1], version("npm", ["--version"])],
  ["Python", pinned("python"), version("python3", ["-c", "import platform; print(platform.python_version())"])],
  ["uv", pinned("uv"), version("uv", ["--version"]).split(/\s+/)[1]],
]) if (actual !== expected) throw new Error(`${name} version mismatch: expected ${expected}, got ${actual}`);
