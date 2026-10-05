import test from "node:test";
import assert from "node:assert/strict";
import { evidenceId, evidenceSources, selectEvidenceSource } from "./evidence.js";
import { evidenceCovers } from "./evidence-coverage.js";

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

test("image placeholders and fabricated text paths never provide physical coverage", () => {
  const material = { messages: [{ role: "assistant", content: "data:image/png;base64,AA==" }] };
  const rendered = evidenceSources(material.messages[0]).find(source => source.kind === "json")!;
  assert(!evidenceCovers(material, ID, evidenceId(ID, 0, "json", "", 0, rendered.text.length), evidenceId(ID, 0, "text", "/content", 0, 1)));
  assert(!evidenceCovers(material, ID, evidenceId(ID, 0, "json", "", 0, rendered.text.length), evidenceId(ID, 0, "json", "", 0, rendered.text.length)));
});
