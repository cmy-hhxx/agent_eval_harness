import { readFile, readdir, stat, mkdir, mkdtemp, cp, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { root } from "./lib.mjs";

// Explicit maintenance command; normal builds only read the checked-in sources.
if (!process.argv[2]) throw new Error("Usage: node scripts/vendor-deepseek.mjs <upstream checkout>");
const source = path.resolve(process.argv[2]);
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
  "packages/client/ui-attachment/tests/message-image.client.spec.tsx",
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
  "packages/client/ui-commands/tests/popup.client.spec.ts",
  "packages/client/ui-commands/tests/popup-view.client.spec.tsx",
  "packages/client/ui-primitives/tests/menu-group.client.spec.tsx",
  "packages/client/ui-primitives/tests/text-shimmer.client.spec.tsx",
  "packages/client/ui-primitives/tests/tooltip.client.spec.tsx",
  "packages/client/ui-conversation/tests/input-reference-submit.client.spec.ts",
  "packages/client/ui-conversation/tests/queue-dock.client.spec.tsx",
  "packages/client/ui-conversation/tests/service-orchestration.client.spec.ts",
  "packages/client/ui-chat/tests/running-status.client.spec.tsx",
  "packages/client/ui-chat/tests/process-groups.client.spec.ts",
  "packages/client/ui-chat/tests/reasoning-row.client.spec.tsx",
  "packages/client/ui-chat/tests/chat-view.client.spec.tsx",
  "packages/client/ui-chat/tests/transcript-view-policy.client.spec.ts",
  "packages/client/ui-tool/tests/tool-row.client.spec.tsx",
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
    const output = typeof value === "string" ? value : value.default || value.import || value.types;
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
for (const file of ["src/client/chat/RunningWhaleTail.tsx", "src/client/chat/running-whale@2x.png", "tests/running-whale-tail.client.spec.tsx"])
  await rm(path.join(destination, "packages/client/ui-chat", file), { force: true });
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
    "Standalone Markdown images are centered within the message column; inline image buttons retain inline layout.",
    "Markdown strong emphasis can close after non-ASCII punctuation before adjacent Latin letters or digits, preserving ASCII CommonMark behavior. Regression tests cover the Eris mixed-language labels while streaming, settling and restoring.",
    "AssistantMarkdown renders consecutive provider text fragments as one Markdown document with a stable first-block key. Authored newlines and non-text boundaries remain intact; split emphasis, tables and links render correctly in both streaming and restored replies. Regression tests exercise the actual assistant component with the Eris fragment pattern.",
    "Original attachment MessageImages/ImageGallery and lightbox are reused for source-reference tool inspection; bytes are resolved by the application only on expansion. Attachment presentation and CSS are unchanged, and upstream image behavior tests are retained.",
    "Web-only source composition: UI, Connection/Gateway, Session client, Markdown, store and required Cordis/Typert dependencies. A staged refresh replaces the selected source graph without retaining deleted files. Aliases and source exports are recorded in sources.json; ordinary builds do not use the adjacent repository, Desktop carriers, native addons or Windows packaging.",
    "local.patch exports the original HTTP RPC handler, allows a server-supplied mux URL, defaults to light, adds attachment/fork/read-only-workspace composition flags, omits an unavailable command launcher and replaces coding placeholder/hero copy. Transport/fold algorithms are unchanged; CSS only removes the unused official running-whale animation rules.",
    "Official logo/wordmark and running-whale artwork, exports, fallback renderers and tests are removed. Application composition omits the brand plugin, settings themes/model marketplace and coding plugins. Application-owned Eris artwork and name occupy the brand slots, including a running-status icon slot; upstream isolated clock, text shimmer and accessibility behavior are retained. The hero headline is Eris in both locales and the empty preview badge is omitted. Theme boot injection is fixed light.",
    "Server bundle substitutes the original llm package manifest version literal for createRequire relative lookup; no protocol version or algorithm change.",
    "ModelSelect's parameterized test uses the identical expected string with toBe, because the repository's Vitest runner does not allow inline snapshots inside it.each.",
    "Settings reuse ui-settings-general with optional technical rows omitted and ui-theme with its appearance selector omitted. Web defaults show detailed work steps and support the upstream 10–22 px conversation font range. Running status copy is localized as analysis; matching upstream tests are updated. All settings CSS and interaction components remain upstream.",
    "Gateway model selection reuses upstream fuzzy search, provider ordering, grouped menus, sticky headings, keyboard focus and ModelListEditor (selectionOnly skips manual model editing). Original token/session metric projections and ToolCallRecovery are reused. Original transport, conversation, Markdown, model selection, menu, queue, running-status, tool-row and metric projection tests with their test-support dependencies and benchmark fixtures/budgets are retained. Agent adapters supply local Pi/session persistence and the installed Chrome binary."
  ],
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
