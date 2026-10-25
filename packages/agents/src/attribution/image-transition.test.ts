import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_POLICY, resolveEvidenceSelection, type ToolContext } from "@eval/contracts";
import { ArtifactStore } from "@eval/data";
import { createRegistry, resolveEvidence, ToolRuntime } from "@eval/tools";
import type { Candidate, RawInput } from "@eval/workflows/inputs";
import { bindAttributionMaterial } from "@eval/workflows/review";
import { investigationIssues } from "./investigation.js";
import type { AttributionTransition } from "./transitions.js";
import type { ProblemProposal } from "./types.js";

test("a viewed image-only final preserves an unknown formation boundary without inventing text or a generator", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "eval-image-transition-"));
  try {
    const inputId = randomUUID(), question = "交付一张宽度至少2像素的PNG图片。";
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=";
    const raw: RawInput = { messages: [{ type: "user_question", role: "user", content: question },
      { type: "final_answer", role: "assistant", content: [{ type: "image", mimeType: "image/png", data }] }] };
    const candidate: Candidate = { batch_id: "image", case_id: "image", version: "aime", name: "aime", input_id: inputId,
      trace_id: null, source: "test", line: 1, question, final_index: 1, reference: null, llm: null,
      answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: null, source_unit: "s", source_values: {}, source_fields: {} } };
    const binding = bindAttributionMaterial(candidate, raw);
    const projectedBank: string[] = [];
    const model = binding.projectModelInput!(binding.modelInput!, projectedBank).answer as {
      final_images: { image_count: number; view_request: { candidate: string; message_index: number } };
    };
    assert.deepEqual(model.final_images, { image_count: 1, view_request: { candidate: "answer", message_index: 1 } });
    assert(!Object.hasOwn(model, "transition_evidence"), "complete evidence navigation stays program-side");
    assert(!Object.hasOwn(model.final_images, "quote"), "navigation must not invent an image observation");
    const context: ToolContext = { attemptId: "image-transition", workdir, inputs: new Map([["answer", binding.request.sources.answer.value]]),
      inputIds: new Map([["answer", inputId]]), policy: { ...DEFAULT_POLICY, maxToolCalls: 2 },
      audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [], evidenceBank: [] },
      artifacts: new ArtifactStore(path.join(workdir, "artifacts")) };
    const runtime = new ToolRuntime(context, createRegistry().select(["view_image"]));
    const viewed = await runtime.execute("view_image", { candidate: "answer", message_index: 1 }, new AbortController().signal);
    assert(!viewed.isError);
    const image = viewed.content.find(item => item.type === "image")!;
    assert(image?.data, "the actual view_image tool must return pixels before the observation is submitted");
    const width = Buffer.from(image.data, "base64").readUInt32BE(16);
    assert.equal(width, 1);
    assert.deepEqual(context.audit.viewedImages, ["answer:1"]);
    const display = JSON.parse(viewed.content.find(item => item.type === "text")!.text!);
    const evidence = resolveEvidence(binding.request.sources.answer.value as RawInput,
      resolveEvidenceSelection(context.audit.evidenceBank!, { ...display.reference, observation: `实际图片宽度为${width}像素，未达到至少2像素的要求。` }, "/reference"),
      "answer", context.audit, "/evidence", inputId);
    const transitions = (binding.request.input.answer as { transitions: AttributionTransition[] }).transitions;
    const delivery = transitions.find(item => item.kind === "delivery")!;
    assert.equal(delivery.actor_index, null);
    assert.equal(delivery.before.length, 0, "no generation process was collected");
    assert(delivery.after.some(item => item.evidence_id === evidence.evidence_id && !Object.hasOwn(item, "quote")), "the image directory must locate pixels without inventing an observation");
    const problem:ProblemProposal={text:'图片宽度未达要求',reason:'实际交付宽度1像素，小于所需2像素。',evidence_status:'已确认',
      responsibility_boundary:delivery.transition_index,component:null,attribution_reason:'已查看图片，形成过程未采集。',uncertainties:['没有生成或渲染记录。']};
    assert.deepEqual(investigationIssues(binding.request, problem, [{...evidence,purposes:['问题','归因']}], context.audit, "/problem"), []);
    assert(investigationIssues(binding.request, problem, [{...evidence,purposes:['问题','归因']}], { ...context.audit, viewedImages: [] }, "/problem")
      .some(issue => issue.code === "investigation_image_required"), "replaying an observation without a real view receipt must still fail");
  } finally { await rm(workdir, { recursive: true, force: true }); }
});
