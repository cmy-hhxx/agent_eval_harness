import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type ToolAudit } from "@eval/contracts";
import { cite, evidenceId, evidenceSources, resolveEvidence } from "./evidence.js";
import { validateTraceEvidence } from "./validation.js";

const inputId = "cc677c19-a7f6-4b1b-87fc-556bc791786a";
const otherId = "5ef086f5-ce15-43b7-8da0-20ca47f15b12";
const audit = (): ToolAudit => ({ calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] });

test("resolving text and JSON retains the original coordinate even when equal text occurs at other paths", () => {
  const raw = { messages: [{ content: "重复\n\"原文\"", metadata: "重复\n\"原文\"" }] };
  const leaves = evidenceSources(raw.messages[0]);
  const ids = [];
  for (const source of leaves) {
    const reference = cite(inputId, 0, source, 0, source.text.length);
    const resolved = resolveEvidence(raw, reference, "answer", audit(), "/evidence", inputId);
    assert.equal(resolved.evidence_id, reference.evidence_id);
    assert.deepEqual(resolved, reference);
    ids.push(resolved.evidence_id);
  }
  assert.equal(new Set(ids).size, 3);
});

test("formal evidence cannot replace a selected origin with another same-message path or a foreign input", () => {
  const raw = { messages: [{ content: "答案", metadata: "其他" }] };
  const source = evidenceSources(raw.messages[0]).find(source => source.path === "/content")!;
  const entry = cite(inputId, 0, source, 0, source.text.length);
  assert.deepEqual(validateTraceEvidence(raw, [{ item: entry, location: "/evidence/0" }], "answer", audit(), 0, inputId), []);
  assert.equal(validateTraceEvidence(raw, [{ item: { ...entry, quote: "其他" }, location: "/evidence/0" }], "answer", audit(), 0, inputId)[0].code, "evidence_quote_mismatch");
  assert.equal(validateTraceEvidence(raw, [{ item: { ...entry, evidence_id: evidenceId(otherId, 0, "text", "/content", 0, 2) }, location: "/evidence/0" }], "answer", audit(), 0, inputId)[0].code, "evidence_source_invalid");
});

test("image origins preserve view and observation guards while ordinary text is never an image by prefix", () => {
  const raw = { messages: [{ content: "[图像观察]这是原始文字", image: "data:image/png;base64,YQ==" }] };
  const imageId = evidenceId(inputId, 0, "image");
  assert.throws(() => resolveEvidence(raw, { evidence_id: imageId, observation: "红色" }, "answer", audit(), "/evidence", inputId), (error: unknown) => error instanceof ValidationError && error.issues![0].code === "image_not_viewed");
  const viewed = { ...audit(), viewedImages: ["answer:0"] };
  const entry = resolveEvidence(raw, { evidence_id: imageId, observation: "红色" }, "answer", viewed, "/evidence", inputId);
  assert.equal(entry.evidence_id, imageId);
  assert.deepEqual(validateTraceEvidence(raw, [{ item: entry, location: "/evidence" }], "answer", viewed, 0, inputId), []);
  const text = evidenceSources(raw.messages[0]).find(source => source.path === "/content")!;
  assert.deepEqual(validateTraceEvidence(raw, [{ item: cite(inputId, 0, text, 0, text.text.length), location: "/evidence" }], "answer", audit(), 0, inputId), []);
});
