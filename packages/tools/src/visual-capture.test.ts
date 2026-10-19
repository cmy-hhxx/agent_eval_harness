import test from "node:test";
import assert from "node:assert/strict";
import { visualCaptureMarkers } from "./visual-capture.js";

test("captured visual envelopes retain real text paths and do not infer rendering or alter prose", () => {
  const message = { role: "assistant", content: [
    { type: "output_text", text: "正文与图表的独立说明。" },
    { type: "output_text", text: '{"jgy_visual":"skipped","ref":"jgy-example"}' },
    { type: "output_text", text: '{"visual":"unsupported","ref":"html-example"}' },
    { type: "image", mimeType: "image/png", data: "AA==" },
  ] };
  const before = structuredClone(message), markers = visualCaptureMarkers(message);
  assert.deepEqual(markers.map(({ path, status, resource_ref }) => ({ path, status, resource_ref })), [
    { path: "/content/1/text", status: "skipped", resource_ref: "jgy-example" },
    { path: "/content/2/text", status: "unsupported", resource_ref: "html-example" },
  ]);
  assert.equal(markers[0]!.text, message.content[1]!.text);
  assert.deepEqual(message, before);
});

test("visual capture parsing does not classify prose, examples, resource payloads or unknown formats", () => {
  for (const text of [
    '说明：{"visual":"unsupported","ref":"html-example"}',
    '```json\n{"visual":"unsupported","ref":"html-example"}\n```',
    '{"visual":"unsupported","ref":"html-example","body":"真实成品"}',
    '{"type":"vis-html","id":"html-example","html":"<p>真实内容</p>"}',
    '{"visual":"available","ref":"html-example"}',
    '{"jgy_visual":"skipped","ref":"other-reference"}',
    '{"visual":"unsupported","ref":""}',
  ]) assert.deepEqual(visualCaptureMarkers({ content: text }), []);
  assert.deepEqual(visualCaptureMarkers({ content: "正文", metadata: { text: '{"visual":"unsupported","ref":"html-example"}' } }), []);
});
