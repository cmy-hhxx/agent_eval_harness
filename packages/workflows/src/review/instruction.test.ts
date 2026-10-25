import test from "node:test";
import assert from "node:assert/strict";
import { bindInstructionReview } from "./instruction.js";
import type { Candidate } from "../inputs/types.js";
import type { ReviewCase } from "@eval/contracts";

test("instruction review navigates unchanged norms and process fields without rereading nested snapshots", () => {
  const raw = { messages: [
    { role: "system", content: "说明😀\n# 规则\n引用原始返回。\n# 例外\n缺少证据时说明。" },
    { role: "user", content: "查询价格。" },
    { type: "llm_turn", name: "查询组件", input_messages: [{ role: "user", content: "旧上下文😀".repeat(20000) }],
      output: [{ role: "assistant", content: "原始返回显示价格为12元。" }] },
    { role: "assistant", content: "价格为12元。" },
  ] };
  const binding = bindInstructionReview({ input_id: "b22298f2-19fd-4f05-91b5-a78a502c8e53", question: "查询价格。", final_index: 3 } as Candidate, raw);
  const material = binding.request.sources.case.value as ReviewCase;
  const input = binding.request.input as any;
  const catalog = input.evidence_catalog.find((entry: any) => entry.source_id === "C003");
  const output = catalog.sections.find((entry: any) => entry.field === "output");
  const text = Array.from(material.evidence.C003);
  assert(text.slice(output.start, output.start + output.length).join("").includes("原始返回显示价格为12元"));
  assert.equal(output.read_request.start, output.start);
  assert(catalog.sections.at(-1).field === "input_messages");
  assert(material.evidence.C003.includes("旧上下文"), "actual input remains available when a rule requires it");
  assert(Math.ceil(output.length / 12000) < Math.ceil(text.length / 6000));
  for (const heading of input.norm_catalog[0].headings)
    assert(Array.from(material.evidence.N001).slice(heading.start).join("").startsWith(heading.title));
});
