import { readFile, readdir, stat, mkdir, cp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { root } from "./lib.mjs";

// Explicit maintenance command; normal builds only read the checked-in sources.
if (!process.argv[2]) throw new Error("Usage: node scripts/vendor-deepseek.mjs <upstream checkout>");
const source = path.resolve(process.argv[2]);
const destination = path.join(root, "vendor/deepseek");
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
  // Test-only dependencies stay out of application bundles; preserve upstream
  // behavior coverage for the model picker and metric projections we compose.
  "packages/client/ui-model-selection/tests/catalog.client.spec.ts",
  "packages/client/ui-model-selection/tests/model-select.client.spec.tsx",
  "packages/llm/token-meter/tests/token-usage-projection.spec.ts",
  "packages/session/session-stats/tests/projection.spec.ts",
];
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
  let output = typeof entry === "string" ? entry : entry?.default || entry?.import || entry?.types;
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
await mkdir(destination, { recursive: true });
for (const name of [...selected].sort()) {
  const { directory, manifest } = packages.get(name);
  const target = path.join(destination, path.relative(source, directory));
  await mkdir(target, { recursive: true });
  for (const item of ["src", "tests", "LICENSE", "package.json"])
    if (await exists(path.join(directory, item))) await cp(path.join(directory, item), path.join(target, item), { recursive: true });
  // Make every available source export addressable without runtime package discovery.
  for (const [key, value] of Object.entries(manifest.exports || {})) {
    if (key.includes("*") || key === "./package.json") continue;
    const output = typeof value === "string" ? value : value.default || value.import || value.types;
    if (!output) continue;
    const file = path.join(directory, output.replace(/^\.\/lib\/(?:types\/)?/, "src/").replace(/\.d\.ts$/, ".ts").replace(/\.[cm]?js$/, ".ts"));
    try { aliases[name + (key === "." ? "" : key.slice(1))] = path.relative(source, await resolveFile(file)); } catch {}
  }
}
for (const name of ["active-stream-reconnect", "long-session-browser", "support"]) await cp(path.join(source, "benchmarks", name), path.join(destination, "benchmarks", name), { recursive: true });
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
if (await exists(path.join(destination, "local.patch"))) execFileSync("git", ["apply", "--directory=vendor/deepseek", path.join(destination, "local.patch")], { cwd: root });
for (const file of ["FishLogo.tsx", "BrandWordmark.tsx"])
  await rm(path.join(destination, "packages/client/ui-primitives/src", file), { force: true });
await cp(path.join(source, "LICENSE"), path.join(destination, "LICENSE"));
await writeFile(path.join(destination, "sources.json"), JSON.stringify({ entries, aliases, packages: [...selected].sort(), dependencies: Object.fromEntries([...external].sort()) }, null, 2) + "\n");
const upstreamFile = path.join(root, "vendor/upstream.json");
const upstream = JSON.parse(await readFile(upstreamFile, "utf8"));
upstream.deepseek = {
  repository: "https://github.com/deepseek-ai/deepseek-harness",
  commit: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  directory: "vendor/deepseek",
  license: "MIT; component-specific licenses retained in copied package directories",
  local_changes: [
    "Source-only UI, Connection/Gateway, Session client, Markdown, store and required Cordis/Typert dependencies; aliases and source exports are recorded in sources.json. No dependency on the adjacent repository at build or run time.",
    "local.patch exports the original HTTP RPC handler, allows a server-supplied mux URL, defaults to light, adds attachment/fork/read-only-workspace composition flags, omits an unavailable command launcher and replaces coding placeholder/hero copy. Transport/fold/render algorithms and all CSS are unchanged.",
    "Official logo/wordmark artwork and their exports, fallback renderers and tests are removed. Application composition omits the brand plugin, settings themes/model marketplace and coding plugins. Application-owned Eris artwork and name occupy the existing brand slots; the hero headline is Eris in both locales and the empty preview badge is omitted. Theme boot injection is fixed light.",
    "Server bundle substitutes the original llm package manifest version literal for createRequire relative lookup; no protocol version or algorithm change.",
    "ModelSelect's parameterized test uses the identical expected string with toBe, because the repository's Vitest runner does not allow inline snapshots inside it.each.",
    "Settings reuse ui-settings-general with optional technical rows omitted and ui-theme with its appearance selector omitted. Chat progress copy is localized as analysis; matching upstream test expectations are updated. All settings CSS and interaction components remain upstream.",
    "Gateway model selection reuses ui-input-trigger, ui-commands, ui-model-selection and ModelListEditor (selectionOnly skips manual model editing). Original token/session metric projections are reused. Original transport, conversation, Markdown, model selection and metric projection tests with their test-support dependencies and benchmark fixtures/budgets are retained. agent test adapters supply local Pi/session persistence and the installed Chrome binary."
  ],
};
await writeFile(upstreamFile, JSON.stringify(upstream, null, 2) + "\n");
console.log(`Vendored ${selected.size} packages (${visited.size} reachable source files).`);
console.log(JSON.stringify(Object.fromEntries(external), null, 2));
