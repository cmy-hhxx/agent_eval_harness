import test from "node:test";
import assert from "node:assert/strict";
import { evidenceId, evidenceSources, selectEvidenceSource, type EvidenceSelectionCache } from "./evidence.js";
import { evidenceCovers, evidenceOverlaps } from "./evidence-coverage.js";

const ID = "11111111-1111-4111-8111-111111111111", PEER = "22222222-2222-4222-8222-222222222222";
const raw = { messages: [{ role: "assistant", content: [{ type: "text", text: '风险先说。\n条件："仅短期"。' },
  { type: "text", text: '风险先说。\n条件："仅短期"。' }], metadata: '风险先说。\n条件："仅短期"。' }] };
const text = (path: string, start = 0, end?: number, message = 0, id = ID) => evidenceId(id, message, "text", path, start,
  end ?? evidenceSources(raw.messages[0]).find(source => source.path === path)!.text.length);
const json = evidenceSources(raw.messages[0]).find(source => source.kind === "json")!;

test("physical containment preserves owner, message, path and exact half-open range", () => {
  const whole = text("/content/0/text"), inside = text("/content/0/text", 1, 4);
  assert(evidenceCovers(raw, ID, whole, inside));
  assert(!evidenceCovers(raw, ID, inside, whole));
  for (const other of [text("/content/1/text"), text("/metadata"), text("/content/0/text", 0, undefined, 1),
    text("/content/0/text", 0, undefined, 0, PEER), evidenceId(ID, 0, "image"), "bad-coordinate",
    text("/content/0/text", 0, 1000), text("/content/0/text", 2, 2)]) assert(!evidenceCovers(raw, ID, whole, other));
});

test("real JSON container covers its escaped complete text leaf without interpreting the display quote", () => {
  const container = evidenceId(ID, 0, "json", "", 0, json.text.length);
  const leaf = selectEvidenceSource([json], "/content/0/text")!;
  assert(evidenceCovers(raw, ID, container, text("/content/0/text")));
  assert(evidenceCovers(raw, ID, evidenceId(ID, 0, "json", "", leaf.start, leaf.end), text("/content/0/text", 2, 5)));
  assert(!evidenceCovers(raw, ID, evidenceId(ID, 0, "json", "", leaf.start + 1, leaf.end), text("/content/0/text")));
  assert(!evidenceCovers(raw, ID, evidenceId(ID, 0, "json", "", leaf.start, leaf.end - 1), text("/content/0/text")));
  assert(!evidenceCovers(raw, ID, evidenceId(ID, 0, "json", "", leaf.start, leaf.end), text("/content/1/text")));
});

test("request-local precomputed sources preserve coverage checks without rendering the message again", () => {
  const material = structuredClone(raw), sources = evidenceSources(material.messages[0]);
  const leaf = selectEvidenceSource(sources.filter(source => source.kind === "json"), "/content/0/text")!;
  const whole = text("/content/0/text"), renderedLeaf = evidenceId(ID, 0, "json", "", leaf.start, leaf.end);
  const cases: [string, string][] = [
    [whole, text("/content/0/text", 1, 4)], [renderedLeaf, text("/content/0/text", 2, 5)],
    [evidenceId(ID, 0, "json", "", leaf.start + 1, leaf.end), whole],
    [renderedLeaf, text("/content/1/text")], [whole, text("/content/0/text", 0, 1000)],
    [whole, text("/content/0/text", 2, 2)], [whole, text("/content/0/text", 0, undefined, 1)],
    [whole, text("/content/0/text", 0, undefined, 0, PEER)], [whole, "bad-coordinate"],
    [whole, evidenceId(ID, 0, "text", "/missing", 0, 1)], [whole, evidenceId(ID, 0, "image")],
  ];
  const expected = cases.map(([covering, covered]) => evidenceCovers(material, ID, covering, covered));
  assert.deepEqual(expected, [true, true, false, false, false, false, false, false, false, false, false]);
  Object.defineProperty(material.messages[0], "content", { get() { throw new Error("message rendered again"); } });
  const cache: EvidenceSelectionCache = new WeakMap();
  assert.deepEqual(cases.map(([covering, covered]) => evidenceCovers(material, ID, covering, covered, sources, cache)), expected);
  const image = { messages: [{ content: "data:image/png;base64,AA==" }] }, imageSources = evidenceSources(image.messages[0]);
  const imageJson = imageSources.find(source => source.kind === "json")!;
  const placeholder = evidenceId(ID, 0, "json", "", 0, imageJson.text.length);
  assert.equal(evidenceCovers(image, ID, placeholder, placeholder), false);
  assert.equal(evidenceCovers(image, ID, placeholder, placeholder, imageSources, cache), false);
});

test("a request-local JSON path index exactly preserves one-shot offsets and isolates source objects", () => {
  const cache: EvidenceSelectionCache = new WeakMap();
  const content = { "a/b~c": [{ text: '前文\n"😀"\\后文', empty: {}, list: [] }, null, -1.25, true], "": { tail: "x" } };
  for (const material of [{ content }, { content: { ...content, prefix: "another source" } }]) {
    const sources = evidenceSources(material).filter(source => source.kind === "json"), json = sources[0];
    const paths = ["", "/content", "/content/a~1b~0c", "/content/a~1b~0c/0", "/content/a~1b~0c/0/text",
      "/content/a~1b~0c/0/empty", "/content/a~1b~0c/0/list", "/content/a~1b~0c/1", "/content/a~1b~0c/2",
      "/content/a~1b~0c/3", "/content/", "/content//tail", "/content/prefix", "/missing", "/content/tool_calls", "/bad~2"];
    const expected = paths.map(path => selectEvidenceSource(sources, path));
    assert.deepEqual(paths.map(path => selectEvidenceSource(sources, path, cache)), expected);
    Object.defineProperty(json, "text", { get() { throw new Error("cached JSON was parsed or scanned again"); } });
    for (const [index, path] of paths.entries()) {
      const selected = selectEvidenceSource(sources, path, cache), original = expected[index];
      assert.equal(selected?.start, original?.start); assert.equal(selected?.end, original?.end);
    }
  }
});

test("image placeholders and fabricated text paths never provide physical coverage", () => {
  const material = { messages: [{ role: "assistant", content: "data:image/png;base64,AA==" }] };
  const rendered = evidenceSources(material.messages[0]).find(source => source.kind === "json")!;
  assert(!evidenceCovers(material, ID, evidenceId(ID, 0, "json", "", 0, rendered.text.length), evidenceId(ID, 0, "text", "/content", 0, 1)));
  assert(!evidenceCovers(material, ID, evidenceId(ID, 0, "json", "", 0, rendered.text.length), evidenceId(ID, 0, "json", "", 0, rendered.text.length)));
});

test("physical overlap detects fragments and crossing pages without equating adjacent or foreign coordinates", () => {
  const part = text("/content/0/text", 2, 8);
  for (const other of [text("/content/0/text", 0, 3), text("/content/0/text", 4, 5), text("/content/0/text", 7, 9)]) {
    assert(evidenceOverlaps(raw, ID, part, other)); assert(evidenceOverlaps(raw, ID, other, part));
  }
  for (const other of [text("/content/0/text", 0, 2), text("/content/0/text", 8, 9), text("/content/1/text", 2, 8),
    text("/metadata", 2, 8), text("/content/0/text", 2, 8, 1), text("/content/0/text", 2, 8, 0, PEER),
    text("/content/0/text", 2, 2000), text("/content/0/text", 2, 2)]) assert(!evidenceOverlaps(raw, ID, part, other));
});

test("JSON overlap maps only the actual escaped value interval, never keys or another leaf", () => {
  const value = '前段\n"条件😀"后段', material = { messages: [{ output: value, other: value }] };
  const rendered = evidenceSources(material.messages[0]).find(source => source.kind === "json")!;
  const leaf = selectEvidenceSource([rendered], "/output")!;
  const start = value.indexOf("条件"), end = start + "条件😀".length;
  const norm = evidenceId(ID, 0, "text", "/output", start, end);
  const quote = JSON.stringify(value), valueStart = leaf.end - quote.length;
  const encodedStart = valueStart + 1 + JSON.stringify(value.slice(0, start)).length - 2;
  const ref = (start: number, end: number) => evidenceId(ID, 0, "json", "", start, end);
  assert(evidenceOverlaps(material, ID, norm, ref(encodedStart + 1, encodedStart + 3)));
  assert(!evidenceOverlaps(material, ID, norm, ref(leaf.start, valueStart + 1)));
  assert(!evidenceOverlaps(material, ID, norm, ref(valueStart + 1, encodedStart)));
  const other = selectEvidenceSource([rendered], "/other")!;
  assert(!evidenceOverlaps(material, ID, norm, ref(other.start, other.end)));
});
