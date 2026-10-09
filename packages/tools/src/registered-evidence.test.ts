import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, evidenceId } from "@eval/contracts";
import { cite, displayEvidence, evidenceSources, parseEvidenceCoordinates, resolveEvidence } from "./evidence.js";

const ownId = "11111111-1111-4111-8111-111111111111";
const peerId = "22222222-2222-4222-8222-222222222222";
const audit = { viewedImages: [] as string[], traceReads: [] };
const raw = { messages: [{ content: "真实本方数据🙂" }] };
const leaf = evidenceSources(raw.messages[0]).find(source => source.path === "/content")!;
const issue = (code: string) => (error: unknown) => error instanceof ValidationError && error.issues?.[0]?.code === code;

test("one copied ID binds identical message coordinates to an exact registered input UUID", () => {
  const own = cite(ownId, 0, leaf, 0, leaf.text.length);
  const peer = cite(peerId, 0, leaf, 0, leaf.text.length);
  assert.equal(own.evidence_id, `ev_${ownId}_0_text_0_${leaf.text.length}_/content`);
  assert.notEqual(own.evidence_id, peer.evidence_id);
  assert.deepEqual(displayEvidence(peer).reference, { evidence_id: peer.evidence_id });
  assert.deepEqual(parseEvidenceCoordinates(own.evidence_id), {
    input_id: ownId, message_index: 0, kind: "text", path: "/content", start: 0, end: leaf.text.length,
  });
  assert.equal(resolveEvidence(raw, own, "answer", audit, "/evidence", ownId).quote, leaf.text);
  assert.throws(() => resolveEvidence(raw, peer, "answer", audit, "/evidence", ownId), issue("evidence_source_invalid"));
  assert.throws(() => resolveEvidence(raw, own, "peer", audit, "/evidence", peerId), issue("evidence_source_invalid"));
  assert.equal(resolveEvidence(raw, peer, "peer", audit, "/evidence", peerId).quote, leaf.text);
});

test("noncanonical coordinate spellings are rejected without rewriting a draft", () => {
  for (const id of [`ev_${ownId}_00_text_0_4_/content`,
    `ev_${ownId}_0_text_00_4_/content`, `ev_${ownId}_0_text_0_04_/content`, `ev_${ownId}_0_TEXT_0_4_/content`]) {
    const ref = { evidence_id: id }, before = structuredClone(ref);
    assert.equal(parseEvidenceCoordinates(id), undefined);
    assert.throws(() => resolveEvidence(raw, ref, "answer", audit, "/evidence", ownId), issue("evidence_id_invalid"));
    assert.deepEqual(ref, before);
  }
  assert.throws(() => evidenceId("answer", 0, "image"), /registered input UUID/);
});

test("repair references preserve the exact embedded source UUID and never offer a different raw source", () => {
  const peer = { messages: [{ content: "对方独立原文" }] };
  const submitted = { evidence_id: `ev_${peerId}_0_text_0_999_/content` };
  const before = structuredClone(submitted);
  assert.throws(() => resolveEvidence(peer, submitted, "B", audit, "/evidence", peerId), (error: unknown) => {
    assert(error instanceof ValidationError);
    const feedback = error.issues![0]!.expected as { suggested_evidence: { reference: { evidence_id: string }; quote: string }[] };
    assert.equal(error.issues![0]!.code, "evidence_range_invalid");
    assert(feedback.suggested_evidence.length);
    for (const item of feedback.suggested_evidence) {
      assert.deepEqual(Object.keys(item.reference), ["evidence_id"]);
      assert.equal(parseEvidenceCoordinates(item.reference.evidence_id)?.input_id, peerId);
      assert.equal(resolveEvidence(peer, item.reference, "B", audit, "/selected", peerId).quote, item.quote);
    }
    return true;
  });
  assert.deepEqual(submitted, before);
});

test("image UUID ownership and actual candidate image audit both remain necessary", () => {
  const image = { messages: [{ content: [{ type: "image", mimeType: "image/png", data: "AA==" }] }] };
  const ref = { evidence_id: evidenceId(peerId, 0, "image"), observation: "实际图片" };
  assert.throws(() => resolveEvidence(image, ref, "B", { ...audit, viewedImages: ["answer:0"] }, "/evidence", peerId), issue("image_not_viewed"));
  assert.throws(() => resolveEvidence(image, ref, "answer", { ...audit, viewedImages: ["answer:0"] }, "/evidence", ownId), issue("evidence_source_invalid"));
  assert.deepEqual(resolveEvidence(image, ref, "B", { ...audit, viewedImages: ["B:0"] }, "/evidence", peerId), {
    evidence_id: ref.evidence_id, message_index: 0, quote: "[图像观察]实际图片",
  });
});

test("a valid full ID does not preserve a second model source selector", () => {
  const reference = { evidence_id: cite(ownId, 0, leaf, 0, leaf.text.length).evidence_id, source: "answer" };
  const before = structuredClone(reference);
  assert.throws(() => resolveEvidence(raw, reference, "answer", audit, "/evidence", ownId), issue("evidence_source_invalid"));
  assert.deepEqual(reference, before);
});
