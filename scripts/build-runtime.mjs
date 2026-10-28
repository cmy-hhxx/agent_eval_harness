import { build as bundle } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./lib.mjs";

export async function buildRuntime(output) {
  const vendor = path.join(root, "vendor/deepseek");
  const sources = JSON.parse(await readFile(path.join(vendor, "sources.json"), "utf8"));
  await bundle({
    entryPoints: [path.join(root, "packages/runtime/src/deepseek.js")],
    outfile: path.join(output, "packages/runtime/src/deepseek.js"),
    bundle: true, format: "esm", platform: "node", target: "node24", packages: "external", sourcemap: true,
    plugins: [{ name: "deepseek-source", setup(build) {
      build.onLoad({ filter: /llm\/llm\/src\/attribution\.ts$/ }, async ({ path: file }) => {
        const manifest = JSON.parse(await readFile(path.join(path.dirname(file), "../package.json"), "utf8"));
        const contents = (await readFile(file, "utf8")).replace(/const \{ version \} = createRequire\(import\.meta\.url\)\('\.\.\/package\.json'\)/, `const { version } = ${JSON.stringify({ version: manifest.version })}`);
        return { contents, loader: "ts" };
      });
      build.onResolve({ filter: /^@deepseek-ai\// }, ({ path: specifier }) => {
        const file = sources.aliases[specifier];
        if (!file) throw new Error(`Missing vendored export: ${specifier}`);
        return { path: path.join(vendor, file) };
      });
    } }],
  });
}
