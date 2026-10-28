import { build } from "vite";
import { buildRuntime } from "./build-runtime.mjs";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./lib.mjs";
import { applyAgentDependencyPatches } from "./apply-agent-dependency-patches.mjs";

await applyAgentDependencyPatches();
await mkdir(path.join(root, "dist/agent"), { recursive: true });
await buildRuntime(path.join(root, "dist"));
await build({ configFile: path.join(root, "agent/vite.config.mjs") });
await copyFile(path.join(root, "agent/src/core/remote-contract.js"), path.join(root, "dist/agent/remote-contract.js"));
