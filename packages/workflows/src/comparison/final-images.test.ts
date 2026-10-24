import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, emptyUsage, parseEvidenceCoordinates, ValidationError,
  type PlannedTask, type SubmissionReceipt, type ToolAudit, type ToolContext } from "@eval/contracts";
import { ArtifactStore } from "@eval/data";
import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { comparisonAgent } from "@eval/agents/comparison";
import { cite, createRegistry, messageContentSources, ToolRuntime } from "@eval/tools";
import { attributionResult, comparisonResult, criteriaResult, emptyAudit, optionalVerificationTask } from "../../../../tests/fixtures/comparison.js";
import { comparisonWorkflow } from "./workflow.js";
import type { Candidate, RawInput } from "../inputs/types.js";
import type { TaskData } from "./types.js";

function fixture(mode: "attribution" | "comparison" | "verification", captureText?: string) {
  const candidates: Record<string, Candidate> = Object.fromEntries(["A", "B"].map(label => [label, {
    batch_id: "batch", case_id: "case", input_id: randomUUID(), version: `version-${label}`,
    name: `model-${label}`, llm: null, trace_id: null, source: "fixture", line: 1,
    question: "计算2+2", final_index: 1, reference: null,
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: null,
      source_unit: "seconds", source_values: {}, source_fields: {} },
  }]));
  const inputs: Record<string, RawInput> = Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [candidate.input_id, {
    messages: [{ role: "user", content: candidate.question }, { role: "assistant",
      content: label === "A" ? [{ type: "text", text: "2+2=4" }, { type: "image", mimeType: "image/png", data: "AA==" }] : "2+2=4",
      ...(label === "A" ? { attachments: [{ type: "image", mimeType: "image/png", data: "AQ==" }] } : {}),
    }],
  }]));
  if (captureText) for (const raw of Object.values(inputs)) {
    const final = raw.messages[1]!;
    final.content = [...(Array.isArray(final.content) ? final.content : [{ type: "output_text", text: final.content }]),
      { type: "output_text", text: captureText }];
  }
  const analysis = criteriaResult(), criteria: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
    inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])),
    data: { stage: "criteria", candidates, reference: null } satisfies TaskData };
  const stage = mode === "attribution" ? "attribution" : "comparison";
  const primary: PlannedTask = { id: randomUUID(), stage, dependencies: { criteria: criteria.id },
    inputIds: stage === "attribution" ? { answer: candidates.A!.input_id } : criteria.inputIds,
    data: { stage, candidates: stage === "attribution" ? { A: candidates.A! } : candidates, reference: null,
      ...(stage === "comparison" ? { group: ["version-A", "version-B"] } : {}) } satisfies TaskData };
  const receipt = (taskId: string, evaluation: unknown): SubmissionReceipt => ({ taskId, status: "succeeded",
    attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 1, evaluatorVersion: "fixture", judge: "fixture",
    evaluation, audit: emptyAudit(), usage: emptyUsage() });
  const dependencies: Record<string, SubmissionReceipt> = { criteria: receipt(criteria.id, analysis) };
  if (stage === "comparison") for (const label of ["A", "B"]) {
    primary.dependencies[label] = randomUUID();
    const result = attributionResult(true, "2+2=4", false, candidates[label]!.input_id);
    result.task_analysis = structuredClone(analysis);
    const source = messageContentSources(inputs[candidates[label]!.input_id]!.messages[1])[0]!;
    const evidence = cite(candidates[label]!.input_id, 1, source, 0, source.text.length);
    result.criterion_assessments.forEach(assessment => { assessment.evidence = [evidence]; });
    result.findings.forEach(finding => { finding.evidence = [evidence]; });
    dependencies[label] = receipt(primary.dependencies[label]!, result);
  }
  const task = mode === "verification" ? optionalVerificationTask(primary) : primary;
  if (mode === "verification") dependencies.draft = receipt(primary.id, comparisonResult(["A", "B"], analysis));
  const binding = comparisonWorkflow.bind(task, inputs, dependencies, { tasks: [criteria, primary, task] });
  const registry = new AgentRegistry([attributionAgent, comparisonAgent]), prepared = registry.prepare(binding);
  return { binding, registry, prepared };
}

for (const mode of ["attribution", "comparison", "verification"] as const)
  test(`${mode} exposes final image views before submission while preserving the real view requirement`, async () => {
    const { binding, registry, prepared } = fixture(mode), candidate = mode === "attribution" ? "answer" : "A";
    const shown = binding.modelInput!;
    const materials: Record<string, unknown>[] = mode === "verification"
      ? (shown.sections as { materials?: Record<string, unknown>[] }[])[0]!.materials!
      : Object.entries(mode === "attribution" ? { answer: shown.answer } : shown.candidates as Record<string, unknown>)
        .map(([candidate, value]) => ({ candidate, ...value as Record<string, unknown> }));
    const answer = materials.find(material => material.candidate === candidate)!;
    const view = { candidate, message_index: 1 };
    assert.deepEqual(answer.final_images, { image_count: 2, view_request: view });
    if (mode !== "attribution") assert.equal(materials.find(material => material.candidate === "B")!.final_images, undefined);
    assert.match(prepared.prompt, /"final_images"/);
    assert(prepared.prompt.includes(JSON.stringify(view)), "the exact view request reaches the model prompt");
    assert.match(prepared.evaluation.systemPrompt, /final_images.*view_image/);
    assert(!prepared.evidenceBank.some(id => parseEvidenceCoordinates(id)?.kind === "image"),
      "announcing an image cannot register a selectable image reference");
    const audit = { ...emptyAudit(), evidenceBank: prepared.evidenceBank };
    const issues = (audit: ToolAudit) => {
      try {
        if (mode === "verification") registry.resolveInspection(binding, { checks: [], concerns: [] }, audit);
        else registry.resolve(binding, {}, audit);
        return [];
      } catch (error) { assert(error instanceof ValidationError); return error.issues!; }
    };
    assert(issues(audit).some(issue => issue.code === "final_image_not_viewed"), "a visible image still must be viewed");
    assert.deepEqual(audit.viewedImages, []);
    const workdir = path.join(os.tmpdir(), `final-images-${randomUUID()}`);
    const context: ToolContext = { attemptId: "test", workdir, audit, policy: DEFAULT_POLICY,
      inputIds: new Map(Object.entries(binding.request.sources).map(([label, source]) => [label, source.id])),
      inputs: new Map(Object.entries(binding.request.sources).map(([label, source]) => [label, source.value])),
      artifacts: new ArtifactStore(path.join(workdir, "artifacts")) };
    const runtime = new ToolRuntime(context, createRegistry().select(["view_image"]));
    const result = await runtime.execute("view_image", view, new AbortController().signal);
    assert(!result.isError);
    assert.equal(result.content.filter(item => item.type === "image").length, 2);
    assert.deepEqual(audit.viewedImages, [`${candidate}:1`]);
    assert(!issues(audit).some(issue => issue.code === "final_image_not_viewed"));
  });

for (const mode of ["attribution", "comparison", "verification"] as const)
  test(`${mode} distinguishes captured visual gaps from user-facing rendering and keeps real image checks`, () => {
    for (const [captureText, status] of [
      ['{"jgy_visual":"skipped","ref":"jgy-example"}', "skipped"],
      ['{"visual":"unsupported","ref":"html-example"}', "unsupported"],
    ]) {
      const { binding, prepared } = fixture(mode, captureText);
      const shown = binding.modelInput!;
      const materials: Record<string, unknown>[] = mode === "verification"
        ? (shown.sections as { materials?: Record<string, unknown>[] }[])[0]!.materials!
          .filter(material => material.kind === "answer")
        : Object.values(mode === "attribution" ? { answer: shown.answer } : shown.candidates as Record<string, unknown>) as Record<string, unknown>[];
      for (const material of materials) {
        const gaps = material.capture_gaps as { status: string; path: string; user_visible_rendering: string }[];
        assert.equal(gaps.length, 1);
        assert.equal(gaps[0]!.status, status);
        assert.equal(gaps[0]!.user_visible_rendering, "unknown");
        assert.match(gaps[0]!.path, /^\/content\/\d+\/text$/u);
        assert((material.final_answer as string).includes(captureText!), "source prose and coordinates stay intact");
      }
      assert.match(prepared.prompt, /"capture_gaps"/);
      assert.match(prepared.prompt, /"final_images"/, "a capture gap cannot suppress a different real image");
      assert.match(prepared.evaluation.systemPrompt, /capture_gaps/);
    }
    const ordinary = fixture(mode, '{"value":4,"description":"normal JSON result"}').binding.modelInput!;
    const json = JSON.stringify(ordinary);
    assert(!json.includes('"capture_gaps"'), "ordinary result JSON is not classified as a capture gap");
  });
