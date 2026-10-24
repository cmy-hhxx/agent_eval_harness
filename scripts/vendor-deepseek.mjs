import { readFile, readdir, stat, mkdir, mkdtemp, cp, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import picomatch from "picomatch";
import yaml from "js-yaml";
import upstreamTests from "../agent/vitest.config.mjs";
import { root } from "./lib.mjs";

// Explicit maintenance command; normal builds only read the checked-in sources.
if (!process.argv[2]) throw new Error("Usage: node scripts/vendor-deepseek.mjs <upstream checkout>");
const source = path.resolve(process.argv[2]);
if (execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: source, encoding: "utf8" }).trim())
  throw new Error("Upstream checkout must be clean before recording its commit");
const recordedDestination = path.join(root, "vendor/deepseek");
const localPatch = await readFile(path.join(recordedDestination, "local.patch"), "utf8");
for (const [, before, after] of [
  ...localPatch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm),
  ...localPatch.matchAll(/^--- a\/(\S+)\n\+\+\+ b\/(\S+)$/gm),
]) {
  if (before !== after) throw new Error(`Local patch must edit the same source path: ${before} -> ${after}`);
}
const exists = (file) => stat(file).then(() => true, () => false);
const packages = new Map();
async function manifests(directory, depth) {
  if (await exists(path.join(directory, "package.json"))) {
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    if (manifest.name) packages.set(manifest.name, { directory, manifest });
  }
  if (!depth) return;
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.name.startsWith(".") && !["node_modules", "src", "tests"].includes(entry.name))
      await manifests(path.join(directory, entry.name), depth - 1);
}
await manifests(path.join(source, "packages"), 2);
await manifests(path.join(source, "vendor"), 1);

const entries = [
  "vendor/cordis/src/index.ts",
  "packages/client/ui-settings-models/src/client/ModelListEditor.tsx",
  "packages/client/ui-settings-general/src/client/index.ts",
  "packages/client/ui-attachment/src/client/MessageImages.tsx",
  "packages/client/ui-attachment/src/client/index.ts",
  "packages/client/ui-file-drag/src/client/index.ts",
  "packages/api/remote-access/src/client/mount.ts",
  "packages/llm/token-meter/src/usage-projection.ts",
  "packages/session/session-stats/src/projection.ts",
  "packages/client/web/src/base.css",
  ...["connection", "file-upload", "locale", "shortcuts", "resources", "ui-renderer", "ui-layout", "ui-sidebar", "ui-session", "ui-conversation", "ui-chat", "ui-tool", "ui-workspace", "ui-sidebar-right", "ui-settings", "ui-trajectory", "ui-input-trigger", "ui-commands", "ui-model-selection"].map((name) => `packages/client/${name}/src/client/index.ts`),
  "packages/typert/registry/src/client/index.ts",
  "packages/api/gateway/src/client/index.ts",
  "packages/api/gateway/src/stream-server.ts",
  "packages/api/session-controller/src/client/index.ts",
  "packages/api/workspace-controller/src/client/index.ts",
  "packages/client/ui-theme/src/client/index.ts",
  "packages/client/ui-theme/src/boot-theme.ts",
  "packages/client/connection/src/rpc-host.ts",
  "packages/core/session/src/index.ts",
  "packages/llm/llm/src/index.ts",
];
const upstreamFiles = execFileSync("git", ["ls-files", "--", "packages"], { cwd: source, encoding: "utf8" }).trim().split("\n");
const patchedFiles = [...localPatch.matchAll(/^\+\+\+ b\/(\S+)$/gm)].map(match => match[1]);
const testMatchers = upstreamTests.test.include.map(pattern => {
  const matches = picomatch(pattern);
  if (![...upstreamFiles, ...patchedFiles].some(file => matches(file))) throw new Error(`Upstream test pattern has no files: ${pattern}`);
  return matches;
});
entries.push(...upstreamFiles.filter(file => testMatchers.some(matches => matches(file))).sort());
const aliases = {}, selected = new Set(), visited = new Set(), external = new Map();
async function resolveFile(file) {
  for (const candidate of [file, file.replace(/\.[cm]?js$/, ".ts"), file + ".ts", file + ".tsx", path.join(file, "index.ts"), file.replace(/\.ts$/, "/index.ts")])
    if (await exists(candidate) && (await stat(candidate)).isFile()) return candidate;
  throw new Error(`Missing source: ${path.relative(source, file)}`);
}
async function resolvePackage(specifier) {
  const name = specifier.split("/").slice(0, 2).join("/");
  const item = packages.get(name);
  if (!item) return;
  const suffix = specifier.slice(name.length);
  const entry = item.manifest.exports?.[suffix ? "." + suffix : "."];
  let output = typeof entry === "string" ? entry : entry?.types || entry?.default || entry?.import;
  if (!output && suffix.startsWith("/src/")) output = "." + suffix;
  if (!output) throw new Error(`No upstream export: ${specifier}`);
  const relative = output.replace(/^\.\/lib\/(?:types\/)?/, "src/").replace(/\.d\.ts$/, ".ts").replace(/\.[cm]?js$/, ".ts");
  const file = await resolveFile(path.join(item.directory, relative));
  aliases[specifier] = path.relative(source, file);
  selected.add(name);
  return file;
}
async function visit(file, owner) {
  file = file.split("?")[0];
  if (visited.has(file)) return;
  visited.add(file);
  const match = [...packages.values()].find((p) => file.startsWith(p.directory + path.sep));
  if (match) { owner = match; selected.add(match.manifest.name); }
  if (!/\.[cm]?[jt]sx?$/.test(file)) return;
  const text = await readFile(file, "utf8");
  const javascript = ts.transpileModule(text, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, experimentalDecorators: true } }).outputText;
  const syntax = ts.createSourceFile(file + ".js", javascript, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = new Set();
  function walk(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(syntax) === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
    ts.forEachChild(node, walk);
  }
  walk(syntax);
  for (const specifier of imports) {
    if (specifier.startsWith("node:")) continue;
    if (specifier.startsWith(".")) {
      await visit(await resolveFile(path.resolve(path.dirname(file), specifier.split("?")[0])), owner);
    } else if (specifier.startsWith("@deepseek-ai/")) {
      const target = await resolvePackage(specifier);
      if (!target) throw new Error(`Unresolved upstream package ${specifier}`);
      await visit(target, owner);
    } else {
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      const dependencies = { ...owner?.manifest.devDependencies, ...owner?.manifest.peerDependencies, ...owner?.manifest.dependencies };
      const version = dependencies[name] || [...packages.values()].map((p) => ({ ...p.manifest.devDependencies, ...p.manifest.dependencies })[name]).find(Boolean);
      if (version) external.set(name, version);
    }
  }
}
for (const entry of entries) await visit(await resolveFile(path.join(source, entry)));
// Prepare a complete source copy before replacing the recorded dependency graph.
// Files removed upstream must not survive in the next build or test discovery.
const destination = await mkdtemp(path.join(root, "vendor/.deepseek-"));
try {
await writeFile(path.join(destination, "local.patch"), localPatch);
for (const name of [...selected].sort()) {
  const { directory, manifest } = packages.get(name);
  const target = path.join(destination, path.relative(source, directory));
  await mkdir(target, { recursive: true });
  for (const item of ["src", "tests", "LICENSE", "package.json"])
    if (await exists(path.join(directory, item))) await cp(path.join(directory, item), path.join(target, item), { recursive: true });
  // Make every available source export addressable without runtime package discovery.
  for (const [key, value] of Object.entries(manifest.exports || {})) {
    if (key.includes("*") || key === "./package.json") continue;
    const output = typeof value === "string" ? value : value.types || value.default || value.import;
    if (!output) continue;
    const file = path.join(directory, output.replace(/^\.\/lib\/(?:types\/)?/, "src/").replace(/\.d\.ts$/, ".ts").replace(/\.[cm]?js$/, ".ts"));
    try { aliases[name + (key === "." ? "" : key.slice(1))] = path.relative(source, await resolveFile(file)); } catch {}
  }
}
for (const name of ["active-stream-reconnect", "long-session-browser", "support"]) await cp(path.join(source, "benchmarks", name), path.join(destination, "benchmarks", name), { recursive: true });
await mkdir(path.join(destination, "scripts"));
await cp(path.join(source, "scripts/test-dom-environment.ts"), path.join(destination, "scripts/test-dom-environment.ts"));
// Remove the upstream hero artwork before patching, so vector data is not
// carried into either the vendored sources or the local patch.
const heroFile = path.join(destination, "packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx");
let hero = await readFile(heroFile, "utf8");
hero = hero.replace("import { useState } from 'react'\n", "")
  .replace("FISH_LOGO_PATH, FISH_LOGO_VIEWBOX, ", "")
  .replace(/\/\* Hover swim morph targets:[\s\S]*?(?=\/\*\*\n \* Render the hero chrome)/, "")
  .replace("  const [hovering, setHovering] = useState(false)\n", "")
  .replace(/            onMouseEnter=\{[\s\S]*?            onMouseLeave=\{[^\n]*\n/, "")
  .replace("fallback: <HeroFish hovering={hovering} />", "fallback: null");
await writeFile(heroFile, hero);
execFileSync("git", ["apply", `--directory=${path.relative(root, destination)}`, path.join(destination, "local.patch")], { cwd: root });
for (const file of ["FishLogo.tsx", "BrandWordmark.tsx"])
  await rm(path.join(destination, "packages/client/ui-primitives/src", file), { force: true });
for (const file of ["src/client/chat/RunningWhaleTail.tsx", "src/client/assets/running-whale@2x.png", "tests/running-whale-tail.client.spec.tsx"])
  await rm(path.join(destination, "packages/client/ui-chat", file), { force: true });
async function sourceAliases(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), name = prefix + "/" + entry.name;
    if (entry.isDirectory()) await sourceAliases(file, name);
    else if (entry.isFile()) aliases[name] = path.relative(destination, file);
  }
}
for (const name of selected) {
  const { directory, manifest } = packages.get(name);
  if (manifest.exports?.["./src/*"] === "./src/*")
    await sourceAliases(path.join(destination, path.relative(source, directory), "src"), name + "/src");
}
const dependencyPatches = [];
const workspace = yaml.load(await readFile(path.join(source, "pnpm-workspace.yaml"), "utf8"));
for (const [identity, file] of Object.entries(workspace.patchedDependencies)) {
  const split = identity.lastIndexOf("@"), name = identity.slice(0, split), version = identity.slice(split + 1);
  if (!external.has(name)) continue;
  await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
  await cp(path.join(source, file), path.join(destination, file));
  dependencyPatches.push({ package: name, version, file });
}
await cp(path.join(source, "LICENSE"), path.join(destination, "LICENSE"));
await writeFile(path.join(destination, "sources.json"), JSON.stringify({ entries, aliases, packages: [...selected].sort(), dependencies: Object.fromEntries([...external].sort()), dependencyPatches }, null, 2) + "\n");
const upstreamFile = path.join(root, "vendor/upstream.json");
const upstream = JSON.parse(await readFile(upstreamFile, "utf8"));
upstream.deepseek = {
  repository: "https://github.com/deepseek-ai/deepseek-harness",
  commit: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  directory: "vendor/deepseek",
  license: "MIT; component-specific licenses retained in copied package directories",
  local_changes: upstream.deepseek.local_changes,
};
const previous = destination + "-previous";
await rename(recordedDestination, previous);
try { await rename(destination, recordedDestination); }
catch (error) { await rename(previous, recordedDestination); throw error; }
await rm(previous, { recursive: true });
await writeFile(upstreamFile, JSON.stringify(upstream, null, 2) + "\n");
console.log(`Vendored ${selected.size} packages (${visited.size} reachable source files).`);
console.log(JSON.stringify(Object.fromEntries(external), null, 2));
} finally {
  await rm(destination, { recursive: true, force: true });
}
