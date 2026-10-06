import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
async function files(directory: string): Promise<string[]> {
  return (
    await Promise.all(
      (
        await readdir(path.join(root, directory), { withFileTypes: true })
      ).map((entry) =>
        entry.isDirectory() ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`],
      ),
    )
  ).flat();
}
const owner = (file: string) => file.startsWith("agent/") ? "agent/assistant" : file.split("/").slice(0, 2).join("/");
const allowed: Record<string, string[]> = {
  assistant: ["contracts", "prompts", "tools", "runtime"],
  contracts: [],
  automations: ["contracts"],
  prompts: ["contracts"],
  data: ["contracts"],
  tools: ["contracts", "data"],
  runtime: ["contracts", "data", "tools"],
  host: ["contracts", "data", "runtime"],
  agents: ["contracts", "tools", "prompts"],
  workflows: ["contracts", "data", "tools", "agents"],
};

test("public package boundaries, independent Agents and acyclic implementation imports", async () => {
  const config = JSON.parse(await readFile(path.join(root, "tsconfig.json"), "utf8"));
  const aliases = config.compilerOptions.paths as Record<string, string[]>;
  const sources = [...(await files("packages")), ...(await files("apps")), ...(await files("agent/src"))].filter(
    (file) => file.includes("/src/") && /\.(?:ts|js)$/.test(file) && !file.endsWith(".test.ts"),
  );
  const graph = new Map<string, string[]>();
  for (const file of sources) {
    const syntax = ts.createSourceFile(
      file,
      await readFile(path.join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const edges: string[] = [];
    for (const node of syntax.statements) {
      if (
        (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier)
      )
        continue;
      const specifier = node.moduleSpecifier.text;
      const from = owner(file),
        pkg = from.split("/")[1];
      if (from === "packages/contracts")
        assert(!specifier.startsWith("node:"), `${file}: Contracts must be pure`);
      let target: string | undefined;
      if (specifier.startsWith(".")) {
        target = path.normalize(path.join(path.dirname(file), specifier)).replace(/\.js$/, ".ts");
        if (specifier.endsWith(".json"))
          assert(target.startsWith("schemas/"), `${file}: relative JSON imports must come from root schemas/`);
        else if (!((file === "packages/runtime/src/deepseek.js" || file.startsWith("agent/src/client/")) && target.startsWith("vendor/deepseek/"))) assert.equal(owner(target), from, `${file}: cross-package relative import ${specifier}`);
      } else if (specifier.startsWith("@eval/")) {
        assert(aliases[specifier], `${file}: undeclared public entry ${specifier}`);
        target = aliases[specifier][0].replace(/^\.\//, "");
        const targetPackage = owner(target).split("/")[1];
        if ((from.startsWith("packages/") || from.startsWith("agent/")) && owner(target) !== from)
          assert(
            allowed[pkg].includes(targetPackage) && target.startsWith("packages/"),
            `${file}: forbidden dependency ${specifier}`,
          );
      }
      if (!target) continue;
      if (from === "packages/agents" && target.startsWith("packages/agents/src/"))
        assert.equal(
          file.split("/")[3],
          target.split("/")[3],
          `Agents must not import each other: ${file} -> ${target}`,
        );
      const typesOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly ||
          (!node.importClause?.name &&
            node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.every((item) => item.isTypeOnly))
        : node.isTypeOnly;
      if (!typesOnly && target.endsWith(".ts")) edges.push(target);
    }
    graph.set(file, edges);
  }
  function visit(file: string, stack: string[], done: Set<string>) {
    assert(!stack.includes(file), `Import cycle: ${[...stack, file].join(" -> ")}`);
    if (done.has(file)) return;
    for (const target of graph.get(file) || []) visit(target, [...stack, file], done);
    done.add(file);
  }
  const done = new Set<string>();
  for (const file of graph.keys()) visit(file, [], done);
  const reachable = new Set<string>();
  const walk = (file: string) => {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const target of graph.get(file) || []) walk(target);
  };
  walk("packages/runtime/src/client-entry.ts");
  for (const file of reachable) {
    assert(
      !file.includes("/adapters/") && !file.endsWith("/server.ts"),
      `Client eagerly loads Worker or SDK: ${file}`,
    );
    assert(!/#(?:pi|prime)-sdk/.test(await readFile(path.join(root, file), "utf8")), file);
  }
});

test("source documentation links and section anchors resolve and remain reachable from README", async () => {
  const docs = [
    "README.md", "AGENTS.md", "PRODUCT.md", "agent/README.md", "evaluation-report/README.md", "schemas/README.md",
    "packages/prompts/README.md", ...(await files("docs")), ...(await files("apps/host/.impeccable")),
  ].filter((file) => file.endsWith(".md"));
  const links = new Map<string, string[]>();
  const headings = (text: string) => new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, title]) =>
      title.replace(/<[^>]+>/g, "").replace(/[`*_]/g, "").toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "").replace(/ /g, "-")),
  );
  for (const file of docs) {
    const text = await readFile(path.join(root, file), "utf8");
    const targets: string[] = [];
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const [href, anchor] = match[1].split("#");
      if (/^[a-z]+:/i.test(href)) continue;
      const target = path.resolve(root, path.dirname(file), href || path.basename(file));
      await access(target);
      targets.push(path.relative(root, target));
      if (anchor && target.endsWith(".md")) {
        const linked = await readFile(target, "utf8");
        assert(headings(linked).has(decodeURIComponent(anchor)), `${file}: missing section ${match[1]}`);
      }
    }
    links.set(file, targets);
  }
  const reachable = new Set<string>();
  const visit = (file: string) => {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const target of links.get(file) ?? []) if (links.has(target)) visit(target);
  };
  visit("README.md");
  for (const file of docs) assert(reachable.has(file), `${file}: not reachable from README.md`);
});
