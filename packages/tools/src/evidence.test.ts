import test from "node:test";
import assert from "node:assert/strict";
import { cite, evidenceSources, imagePlaceholder, resolveEvidence } from "./evidence.js";

const textSources = (message: unknown) => evidenceSources(message).filter((source) => source.kind === "text");
const rendered = (message: unknown) => evidenceSources(message).find((source) => source.kind === "json")!.text;

test("ordinary data remains source text at any length and resolves exact escaped quotes", () => {
  for (const data of ["原始数据", '原始数据"\\\n🙂'.repeat(3000)]) {
    const message = { type: "tool_result", output: { data } }, raw = { messages: [message] };
    const source = textSources(message).find((source) => source.path === "/output/data");
    assert(source);
    assert.equal(source.text, data);
    assert.equal(rendered(message), JSON.stringify(message, null, 2));
    const evidence = cite(0, source, 2, data.length);
    assert.deepEqual(resolveEvidence(raw, evidence, "answer", [], "/evidence"), {
      message_index: 0, quote: data.slice(2),
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
    const evidence = cite(0, source, 0, source.text.length);
    assert.deepEqual(resolveEvidence(raw, evidence, "answer", [], "/evidence"), {
      message_index: 0, quote: source.text,
    });
  }
  assert.throws(() => resolveEvidence(raw, {
    evidence_id: "ev_0_text_0_4_/content/0/data",
  }, "answer", [], "/evidence"), /证据原文位置无效/);
  const source = evidenceSources(message).find((source) => source.kind === "json")!;
  assert.throws(() => resolveEvidence(raw, cite(0, source, 0, source.text.length), "answer", [], "/evidence"), /占位符不能作为原文证据/);
});
