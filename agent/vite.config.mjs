import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const upstream = path.join(root, "vendor/deepseek");
const { aliases } = JSON.parse(readFileSync(path.join(upstream, "sources.json"), "utf8"));
export default defineConfig({
  root: path.join(root, "agent"),
  base: "./",
  resolve: {
    alias: Object.entries(aliases).sort(([a], [b]) => b.length - a.length)
      .map(([find, file]) => ({ find, replacement: path.join(upstream, file) })),
    dedupe: ["react", "react-dom"],
  },
  esbuild: { jsx: "automatic", tsconfigRaw: { compilerOptions: { experimentalDecorators: false } } },
  define: { "process.env.DSH_CLIENT_BUILD_PROFILE": JSON.stringify("official"), "process.env.DSH_CLIENT_TITLE": JSON.stringify("Eris"), "process.env.NODE_ENV": JSON.stringify("production") },
  build: { outDir: path.join(root, "dist/agent/web"), emptyOutDir: true, target: "es2023", sourcemap: true },
});
