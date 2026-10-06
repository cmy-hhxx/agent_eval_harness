import test from "node:test";
import assert from "node:assert/strict";
import { messageContentSources } from "./evidence.js";

test("final prose sources exclude output_text metadata while retaining original text paths", () => {
  const message = { role: "assistant", content: [{ type: "output_text", text: "销量4,602,436辆。" }, { type: "text", text: "同比增长7.73%。" }] };
  assert.deepEqual(messageContentSources(message), [
    { kind: "text", path: "/content/0/text", text: "销量4,602,436辆。" },
    { kind: "text", path: "/content/1/text", text: "同比增长7.73%。" },
  ]);
  assert.deepEqual(messageContentSources({ content: "正文" }), [{ kind: "text", path: "/content", text: "正文" }]);
  assert.deepEqual(messageContentSources({ content: [{ type: "image", data: "data:image/png;base64,AA==", mimeType: "image/png" }] }), []);
});
