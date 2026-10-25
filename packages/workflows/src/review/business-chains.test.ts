import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidenceBankSources } from "@eval/contracts";
import { businessChains } from "./business-chains.js";

test("multimodal tool returns expose original text without citing image placeholders", () => {
  const id = "19b0f4da-601f-46d2-83bc-1adec8758217";
  const raw = { messages: [
    { role: "user", content: "查看图表" },
    { type: "tool_call", name: "chart", call_id: "chart-call", arguments: {} },
    { type: "tool_result", name: "chart", call_id: "chart-call", output: [
      { text: "<referencable-result>\nID: 30\n", type: "input_text" },
      { text: "<image width=700 height=720>", type: "input_text" },
      { detail: "low", image_url: "data:image/png;base64,AA==", type: "input_image" },
      { text: "</image width=700 height=720>", type: "input_text" },
      { text: "原始图表说明。".repeat(1000), type: "input_text" },
      { text: "</referencable-result>", type: "input_text" },
    ] },
    { role: "assistant", content: "图表已展示。" },
  ] };
  const before = structuredClone(raw), chains = businessChains(raw, id, 3);
  const returned = chains[0]!.checkpoints[3]!.evidence;
  assert(returned.length > 0, "captured return text remains available");
  assert(returned.some(item => item.quote.includes("ID: 30")));
  assert(returned.some(item => item.quote.includes("原始图表说明")));
  assert(returned.reduce((total, item) => total + item.quote.length, 0) <= 4800);
  validateEvidenceBankSources(chains.flatMap(chain => chain.checkpoints.flatMap(point =>
    point.evidence.map(item => item.evidence_id))), new Map([[id, raw]]));
  assert.deepEqual(raw, before);
});
