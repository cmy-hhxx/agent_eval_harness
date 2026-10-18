import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const excludedRoots = new Set([".git", "vendor", "data", "log", "tmp", ".runtime", ".venv", ".cache", ".artifacts"]);

async function documents(directory = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory())
      return excludedRoots.has(file) || ["node_modules", "dist"].includes(entry.name) || file === "packages/prompts/resources"
        ? [] : documents(file);
    return entry.isFile() && file.endsWith(".md") ? [file] : [];
  }))).flat();
}

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  url?: string;
  identifier?: string;
};

function references(markdown: string) {
  const tree = fromMarkdown(markdown);
  const anchors = new Set<string>(), links: string[] = [];
  const definitions = new Map<string, string>();
  const pending: string[] = [];
  const plainText = (node: MarkdownNode): string => node.type === "html" ? "" : node.value ?? (node.children ?? []).map(plainText).join("");
  function visit(node: MarkdownNode) {
    if (node.type === "heading") {
      const base = plainText(node).toLowerCase().replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "").replace(/ /g, "-");
      let anchor = base, suffix = 0;
      while (anchors.has(anchor)) anchor = `${base}-${++suffix}`;
      anchors.add(anchor);
    }
    if (node.type === "link" || node.type === "image") links.push(node.url!);
    if (node.type === "definition") definitions.set(node.identifier!, node.url!);
    if (node.type === "linkReference" || node.type === "imageReference") pending.push(node.identifier!);
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  for (const id of pending) {
    assert(definitions.has(id), `Missing Markdown reference: ${id}`);
    links.push(definitions.get(id)!);
  }
  return { anchors, links };
}

test("documentation parsing ignores code examples and resolves formatted headings and reference links", () => {
  const parsed = references([
    "# A `tool` 与 **结果**", "# A `tool` 与 <span>结果</span>",
    "[guide][doc]", "[doc]: <guide.md#标题> \"Guide\"", "![image](image.png)",
    "`[not a link](missing.md)`", "```md", "# Not a heading", "[example](missing.md)", "```",
  ].join("\n\n"));
  assert.deepEqual([...parsed.anchors], ["a-tool-与-结果", "a-tool-与-结果-1"]);
  assert.deepEqual(parsed.links, ["image.png", "guide.md#标题"]);
});

test("all project documentation has valid local links and is reachable from README", async () => {
  const docs = await documents();
  const parsed = new Map(await Promise.all(docs.map(async file =>
    [file, references(await readFile(path.join(root, file), "utf8"))] as const)));
  const graph = new Map<string, string[]>();
  for (const [file, { links }] of parsed) {
    const targets: string[] = [];
    for (const link of links) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue;
      const [href, anchor] = link.split("#");
      assert(!href.startsWith("/"), `${file}: use repository-relative links: ${link}`);
      const target = path.resolve(root, path.dirname(file), decodeURIComponent(href.split("?")[0]) || path.basename(file));
      const relative = path.relative(root, target);
      assert(!relative.startsWith(".."), `${file}: link leaves the repository: ${link}`);
      await assert.doesNotReject(access(target), `${file}: missing target ${link}`);
      targets.push(relative);
      if (anchor && target.endsWith(".md")) {
        const contents = parsed.get(relative) ?? references(await readFile(target, "utf8"));
        assert(contents.anchors.has(decodeURIComponent(anchor)), `${file}: missing section ${link}`);
      }
    }
    graph.set(file, targets);
  }
  const reachable = new Set<string>();
  function visit(file: string) {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const target of graph.get(file) ?? []) if (graph.has(target)) visit(target);
  }
  visit("README.md");
  for (const file of docs) assert(reachable.has(file), `${file}: not reachable from README.md`);
});
