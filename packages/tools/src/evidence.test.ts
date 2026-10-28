const INPUT_ID = "11111111-1111-4111-8111-111111111111";
import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "@eval/contracts";
import { cite, evidenceSources, imagePlaceholder, parseEvidenceCoordinates, resolveEvidence, selectEvidenceSource } from "./evidence.js";
import { emptyAudit } from "../../../tests/fixtures/comparison.js";

const textSources = (message: unknown) => evidenceSources(message).filter((source) => source.kind === "text");
const rendered = (message: unknown) => evidenceSources(message).find((source) => source.kind === "json")!.text;

test("leaf evidence does not serialize a message and JSON is rendered once only when needed", () => {
  let serializations = 0;
  const value = { content: "可引用的原文", unused: "长材料".repeat(100000) };
  const message = { ...value, toJSON() { serializations++; return value; } };
  const sources = evidenceSources(message);
  const leaf = selectEvidenceSource(sources, "/content")!;
  assert.equal(cite(INPUT_ID, 0, leaf.source, 0, leaf.end).quote, value.content);
  assert.equal(serializations, 0);
  const json = sources.find(source => source.kind === "json")!;
  assert.equal(json.quotable, undefined);
  assert.equal(json.text, JSON.stringify(value, null, 2));
  assert.equal(json.text, JSON.stringify(value, null, 2));
  assert.equal(serializations, 1);
});

test("raw image observations must be strings even when independent evidence checks run before schema validation", () => {
  const raw = { messages: [{ content: [{ type: "image", mimeType: "image/png", data: "AA==" }] }] };
  const audit = { ...emptyAudit(), viewedImages: ["answer:0"] };
  for (const observation of [{ text: "图像" }, 27.98, null, ["图像"], true]) {
    const submitted = { evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_image", observation };
    assert.throws(() => resolveEvidence(raw, submitted, "answer", audit, "/findings/0/evidence/0", INPUT_ID), (error: unknown) => {
      assert(error instanceof ValidationError);
      assert.equal(error.issues![0]!.code, "image_observation_missing");
      assert.deepEqual(error.issues![0]!.actual, submitted);
      return true;
    });
  }
  assert.deepEqual(resolveEvidence(raw, { evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_image", observation: "实际图像观察" }, "answer", audit, "/evidence", INPUT_ID),
    { evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_image", message_index: 0, quote: "[图像观察]实际图像观察" });
});

test("public evidence coordinates preserve the selected leaf and distinguish JSON and image sources", () => {
  const message = { content: [{ text: "相同规范" }, { text: "相同规范" }], "a/b~c": "🙂条件" };
  const sources = evidenceSources(message);
  for (const path of ["/content/0/text", "/content/1/text", "/a~1b~0c"]) {
    const source = sources.find(source => source.path === path)!;
    const ref = cite(INPUT_ID, 7, source, 0, source.text.length);
    assert.deepEqual(parseEvidenceCoordinates(ref.evidence_id), { input_id: INPUT_ID,
      message_index: 7, kind: "text", path, start: 0, end: source.text.length,
    });
  }
  assert.deepEqual(parseEvidenceCoordinates("ev_11111111-1111-4111-8111-111111111111_7_json_0_5_"), { input_id: INPUT_ID,
    message_index: 7, kind: "json", path: "", start: 0, end: 5,
  });
  assert.deepEqual(parseEvidenceCoordinates("ev_11111111-1111-4111-8111-111111111111_7_image"), { input_id: INPUT_ID, message_index: 7, kind: "image" });
  for (const invalid of ["ev_11111111-1111-4111-8111-111111111111_7_text_0_*_/content", "ev_11111111-1111-4111-8111-111111111111_7_text_0_5", "ev_11111111-1111-4111-8111-111111111111_7_image_/content", "invented"])
    assert.equal(parseEvidenceCoordinates(invalid), undefined);
  // Parsing identifies coordinates; normal resolution still rejects an impossible raw range.
  assert.deepEqual(parseEvidenceCoordinates("ev_11111111-1111-4111-8111-111111111111_0_text_0_999_/content/1/text"), { input_id: INPUT_ID,
    message_index: 0, kind: "text", path: "/content/1/text", start: 0, end: 999,
  });
  assert.throws(() => resolveEvidence({ messages: [message] },
    { evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_text_0_999_/content/1/text" }, "answer", emptyAudit(), "/evidence", INPUT_ID), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.equal(error.issues![0]!.code, "evidence_range_invalid");
    return true;
  });
  const raw = { messages: [{ role: "tool", content: '**收益**\n"中文"\\path', data: { value: 0.9957, count: 12 } }] };
  for (const source of evidenceSources(raw.messages[0])) {
    for (let start = 0; start < source.text.length; start += 7) {
      const reference = cite(INPUT_ID, 0, source, start, Math.min(start + 7, source.text.length));
      assert.equal(resolveEvidence(raw, reference, "answer", emptyAudit(), "/evidence", INPUT_ID).quote,
        source.text.slice(start, start + 7));
    }
  }
});

test("invalid coordinates offer references to previously read data without accepting guessed coordinates", () => {
  const raw = { messages: [{ output: { columns: ["价格"], datas: [{ contract: "MA611", price: 3526, volume: 152.9, note: "说明".repeat(200) }] } }] };
  const selected = selectEvidenceSource(evidenceSources(raw.messages[0]), "/output/datas/0")!;
  const audit = emptyAudit();
  audit.traceReads = [
    { candidate: "other", message_index: 0, kind: "json", path: "", start: selected.start, end: selected.end },
    { candidate: "answer", message_index: 0, kind: "json", path: "", start: 0, end: 20 },
    { candidate: "answer", message_index: 0, kind: "json", path: "", start: selected.start, end: selected.end },
    { candidate: "answer", message_index: 0, kind: "json", path: "", start: selected.start, end: selected.end },
    { candidate: "answer", message_index: 0, kind: "json", path: "", start: -1, end: 12 },
    { candidate: "answer", message_index: 0, kind: "text", path: "/output/missing", start: 0, end: 10 },
  ];
  const submitted = { evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_text_13156_13596" };
  assert.throws(() => resolveEvidence(raw, submitted, "answer", audit, "/evidence", INPUT_ID), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.equal(error.issues![0]!.code, "evidence_id_invalid");
    const feedback = error.issues![0]!.expected as { suggested_evidence: { reference: { evidence_id: string }; quote_preview?: string; has_more?: boolean }[] };
    const expected = cite(INPUT_ID, 0, selected.source, selected.start, selected.end);
    assert.equal(feedback.suggested_evidence[0]?.reference.evidence_id, expected.evidence_id);
    assert.equal(feedback.suggested_evidence.filter((entry) => entry.reference.evidence_id === expected.evidence_id).length, 1);
    assert.match(feedback.suggested_evidence[0]!.quote_preview!, /MA611/);
    assert.equal(feedback.suggested_evidence[0]!.quote_preview!.length, 200);
    assert.equal(feedback.suggested_evidence[0]!.has_more, true);
    assert.equal(resolveEvidence(raw, feedback.suggested_evidence[0]!.reference, "answer", audit, "/evidence", INPUT_ID).quote, expected.quote);
    assert.deepEqual(error.issues![0]!.actual, submitted);
    return true;
  });
});

test("malformed coordinates offer exact structured evidence without accepting or rewriting the ID", () => {
  const message = { output: { datas: [{ code: "510630.SH", roe: 27.97773 }], code_count: 108,
    "a/b~c": { data: "值\"\\\n🙂" }, missing: null } };
  const raw = { messages: [message] };
  for (const [path, quote] of [["/output/datas/0", "510630.SH"], ["/output/code_count", '"code_count": 108'],
    ["/output/a~1b~0c", "🙂"], ["/output/missing", '"missing": null']]) {
    const submitted = { evidence_id: `ev_11111111-1111-4111-8111-111111111111_0_text_0_*_${path}` };
    assert.throws(() => resolveEvidence(raw, submitted, "answer", emptyAudit(), "/evidence", INPUT_ID), (error: unknown) => {
      assert(error instanceof ValidationError);
      const issue = error.issues![0]!;
      assert.equal(issue.code, "evidence_id_invalid");
      assert.deepEqual(issue.actual, submitted);
      const feedback = issue.expected as { suggested_evidence: { reference: { evidence_id: string }; quote: string }[]; read_request: { tool: string; arguments: object } };
      assert.equal(feedback.read_request.tool, "read_trace");
      assert(feedback.suggested_evidence.some((item) => item.quote.includes(quote!)));
      for (const item of feedback.suggested_evidence) {
        assert.deepEqual(Object.keys(item.reference), ["evidence_id"]);
        assert(!Object.hasOwn(item, "evidence_id"));
        assert.deepEqual(resolveEvidence(raw, item.reference, "answer", emptyAudit(), "/evidence", INPUT_ID), {
          evidence_id: item.reference.evidence_id, message_index: 0, quote: item.quote });
        assert(rendered(message).includes(item.quote));
      }
      return true;
    });
    assert.equal(submitted.evidence_id, `ev_11111111-1111-4111-8111-111111111111_0_text_0_*_${path}`);
  }
});

test("an invented path gets a message read request without invented replacement evidence", () => {
  assert.throws(() => resolveEvidence({ messages: [{ output: { value: 1 } }] },
    { evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_text_0_*_/output/invented" }, "answer", emptyAudit(), "/evidence", INPUT_ID), (error: unknown) => {
      assert(error instanceof ValidationError);
      const feedback = error.issues![0]!.expected as { suggested_evidence: unknown[]; read_request: { arguments: object } };
      assert.deepEqual(feedback.suggested_evidence, []);
      assert.deepEqual(feedback.read_request.arguments, { candidate: "answer", message_index: 0 });
      return true;
    });
});

test("partial image placeholder coordinates cannot become evidence", () => {
  const raw = { messages: [{ content: [{ type: "image", mimeType: "image/png", data: "AA==" }] }] };
  const source = evidenceSources(raw.messages[0]).find((item) => item.kind === "json")!;
  const start = source.text.indexOf(imagePlaceholder);
  for (const [from, to] of [[start - 4, start + 2], [start + 3, start + 6], [start + imagePlaceholder.length - 2, start + imagePlaceholder.length + 2]]) {
    assert.throws(() => resolveEvidence(raw, cite(INPUT_ID, 0, source, from!, to!), "answer", emptyAudit(), "/evidence", INPUT_ID), /占位符不能作为原文证据/);
  }
});

test("ordinary data remains source text at any length and resolves exact escaped quotes", () => {
  for (const data of ["原始数据", '原始数据"\\\n🙂'.repeat(3000)]) {
    const message = { type: "tool_result", output: { data } }, raw = { messages: [message] };
    const source = textSources(message).find((source) => source.path === "/output/data");
    assert(source);
    assert.equal(source.text, data);
    assert.equal(rendered(message), JSON.stringify(message, null, 2));
    const evidence = cite(INPUT_ID, 0, source, 2, data.length);
    assert.deepEqual(resolveEvidence(raw, evidence, "answer", emptyAudit(), "/evidence", INPUT_ID), {
      evidence_id: evidence.evidence_id, message_index: 0, quote: data.slice(2),
    });
  }
});

test("explicit image data is omitted from text evidence even for small base64 payloads", () => {
  for (const node of [
    { type: "image", mimeType: "image/png", data: "AA==" },
    { type: "image", mime_type: "image/jpeg", data: "AQ==" },
    { type: "image", mimeType: "IMAGE/WEBP", data: "Ag==" },
  ]) {
    const message = { role: "assistant", content: [node] };
    assert(!textSources(message).some((source) => source.path === "/content/0/data"));
    assert.equal(JSON.parse(rendered(message)).content[0].data, imagePlaceholder);
    assert.equal(node.data.length, 4, "hiding image data must not depend on a length threshold");
    assert(textSources(message).some((source) => source.path === "/content/0/type" && source.text === "image"));
  }
});

test("image recognition uses each immediate node rather than inherited or nearby MIME fields", () => {
  const data = "普通文本".repeat(6000);
  const message = {
    type: "image", mimeType: "image/png", metadata: { data },
    nested: [
      { type: "text", mimeType: "image/png", data },
      { type: "image", mimeType: "text/plain", data },
      { type: "image", data },
      { mimeType: "image/png", data },
      { type: "image", metadata: { mimeType: "image/png" }, data },
      { type: "image", mimeType: "image/png", data: "AA==" },
    ],
  };
  const texts = new Map(textSources(message).map((source) => [source.path, source.text]));
  assert.equal(texts.get("/metadata/data"), data);
  for (let index = 0; index < 5; index++) assert.equal(texts.get(`/nested/${index}/data`), data);
  assert.equal(texts.has("/nested/5/data"), false);
  const json = JSON.parse(rendered(message));
  assert.equal(json.metadata.data, data);
  for (let index = 0; index < 5; index++) assert.equal(json.nested[index].data, data);
  assert.equal(json.nested[5].data, imagePlaceholder);
});

test("image data URLs are consistently hidden at any path or nesting depth", () => {
  const url = "data:image/png;base64,AA==";
  const message = {
    role: "assistant", content: [{ image_url: { url } }],
    nested: { ordinary_key: url, data: "data:IMAGE/JPEG;base64,AQ==" },
    text: "说明中的 data:image/png;base64,AA== 不是图片字段",
    data: "data:text/plain;base64,AA==",
  };
  const texts = new Map(textSources(message).map((source) => [source.path, source.text]));
  assert(!texts.has("/content/0/image_url/url"));
  assert(!texts.has("/nested/ordinary_key"));
  assert(!texts.has("/nested/data"));
  assert.equal(texts.get("/text"), message.text);
  assert.equal(texts.get("/data"), message.data);
  const json = JSON.parse(rendered(message));
  assert.equal(json.content[0].image_url.url, imagePlaceholder);
  assert.equal(json.nested.ordinary_key, imagePlaceholder);
  assert.equal(json.nested.data, imagePlaceholder);
  assert.equal(json.text, message.text);
  assert.equal(json.data, message.data);
  assert.deepEqual(textSources(url), []);
  assert.equal(JSON.parse(rendered(url)), imagePlaceholder);
});

test("nested retained text resolves its original coordinates while image payload IDs are invalid", () => {
  const message = {
    content: [
      { type: "image", mimeType: "image/png", data: "AA==" },
      { type: "text", text: '数值为 "4"，路径\\原文\n第二行' },
    ],
    "a/b~c": { data: "原始工具数据" },
  };
  const raw = { messages: [message] };
  for (const source of textSources(message).filter((source) => source.path === "/content/1/text" || source.path === "/a~1b~0c/data")) {
    const evidence = cite(INPUT_ID, 0, source, 0, source.text.length);
    assert.deepEqual(resolveEvidence(raw, evidence, "answer", emptyAudit(), "/evidence", INPUT_ID), {
      evidence_id: evidence.evidence_id, message_index: 0, quote: source.text,
    });
  }
  assert.throws(() => resolveEvidence(raw, {
    evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_text_0_4_/content/0/data",
  }, "answer", emptyAudit(), "/evidence", INPUT_ID), /证据原文位置无效/);
  const source = evidenceSources(message).find((source) => source.kind === "json")!;
  assert.throws(() => resolveEvidence(raw, cite(INPUT_ID, 0, source, 0, source.text.length), "answer", emptyAudit(), "/evidence", INPUT_ID), /占位符不能作为原文证据/);
});
