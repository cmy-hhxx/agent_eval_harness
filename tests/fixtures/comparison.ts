import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, emptyUsage, type AttemptSpec, EngineIdentity, ToolAudit, TaskAnalysis, CriteriaInput, PlannedTask, AgentBackend, RunState, SubmissionReceipt } from "@eval/contracts";
import { criteriaProfile, criteriaSources, type CriterionSource, type CriteriaSubmission } from "@eval/agents/criteria";
import { evidenceId, hasSourceTextBlock, parseEvidenceCoordinates } from "@eval/tools";
import { canonicalEvidence } from "./evidence.js";
import { ROOT } from "./services.js";
import { writeJson, writeJsonl } from "@eval/data";
import { loadConfig, createModelResolver } from "@eval/host-app/config";
import type { AttributionResult, ComparisonResult, RawInput, TaskData } from "@eval/workflows/comparison";
import { comparisonSubmission } from "./comparison-submission.js";
import { problemSubmission, normSelection } from "./attribution-submission.js";
import type { ComparisonSlot } from "@eval/agents/comparison";
import { comparisonWorkflow } from "@eval/workflows/comparison";

export const fakeIdentity: EngineIdentity = {
  engine: "pi",
  version: "fixture",
  commit: "fixture",
  buildId: "fixture",
};
/** Evaluation identity for hand-built manifests and receipts. */
export const fakeEvaluatorVersion = "fixture";
/** Resolved model ID for hand-built receipts. */
export const fakeJudge = "fixture";
export const emptyAudit = (): ToolAudit => ({
  evidenceBank: [],
  calls: 0,
  requiredReadCalls: 0,
  viewedImages: [],
  traceReads: [],
  calculations: [],
  artifacts: [],
});
/** An explicitly requested independent check, outside the primary evaluation dependency graph. */
export function optionalVerificationTask(source: PlannedTask): PlannedTask {
  const data = source.data as TaskData;
  if (source.stage !== "comparison" || data.verificationOf || data.verificationAudit)
    throw new Error("Optional verification requires a primary comparison task");
  return { id: randomUUID(), stage: "comparison", inputIds: { ...source.inputIds },
    dependencies: { ...source.dependencies, draft: source.id },
    data: { ...structuredClone(data), verificationOf: { taskId: source.id }, verificationAudit: true } satisfies TaskData };
}
export function raw(caseId = "q1", reference: unknown = "4", answer = "2+2=4"): RawInput {
  return {
    batch_id: "b1",
    case_id: caseId,
    messages: [
      { type: "message", role: "user", content: "计算2+2" },
      { type: "message", role: "assistant", content: answer },
    ],
    meta: { ok: true, ground_truth: reference, finish_answer_time_cost: 1200 },
  };
}
export function comparisonResult(labels: string[] = ["A", "B"], analysis: TaskAnalysis = criteriaResult()): ComparisonResult {
  return {
    status: "decided", review_requests: [],
    task_analysis: analysis,
    ranking: [labels],
    assessments: Object.fromEntries(
      labels.map((label) => [label, { meets_core: true, core_failure_refs: [], summary: "正确给出了结果。" }]),
    ),
    decision_basis: {
      tradeoff: "双方均满足同一要求，没有结果差异。",
      comparisons: [{ aspect: "计算结果", criterion_ids: ["r1"], importance: "high", better_candidates: [], assessments: Object.fromEntries(
        labels.map((label) => [label, { status: "met", evidence_status: "established", summary: "正确给出4。", finding_indices: [0] }]),
      ) }],
      decisive_findings: labels.map((label) => ({ candidate: label, finding_index: 0 })),
    },
  };
}
function criteriaDraft(sources: CriterionSource[]): CriteriaSubmission {
  return { requirements: [{ source_indices: sources.filter((source) => source.kind === "question" || source.kind === "reference").map((source) => source.source_index) }],
    scoring_points: [], red_flags: [] };
}
export function criteriaResult(input: CriteriaInput = { question: "计算2+2", ground_truth: { available: true, value: "4" },
  candidates: [{ candidate_id: "7c4e3ba8-8f7c-46cc-b8fb-3016e10ea2dd", instructions: [], context: [] }] }): TaskAnalysis {
  const request = { input: input as unknown as import("@eval/contracts").JsonObject, sources: {} };
  const result = criteriaProfile.resolve!(request, criteriaDraft(criteriaSources(input)), emptyAudit()) as TaskAnalysis;
  criteriaProfile.validate!(request, result, emptyAudit());
  return result;
}
/** The explicit Criteria scope for focused fixtures without a complete task plan. */
export function criteriaTaskFor(task: PlannedTask): PlannedTask {
  const data = task.data as { candidates: Record<string, { input_id: string }> };
  return { ...task, id: task.dependencies.criteria ?? task.id, stage: "criteria", dependencies: {}, data: { ...data, stage: "criteria" },
    inputIds: Object.fromEntries(Object.entries(data.candidates).map(([label, candidate]) => [label, candidate.input_id])) };
}
/** A legal accepted rubric derived from exactly the same material as its real Criteria task. */
export function criteriaResultForTask(task: PlannedTask, inputs: Record<string, unknown>): TaskAnalysis {
  const criterionTask = criteriaTaskFor(task);
  const binding = comparisonWorkflow.bind(criterionTask, inputs, {}, { tasks: [criterionTask] });
  return criteriaResult(binding.request.input as unknown as CriteriaInput);
}
export async function fixtureConfig(
  rows: RawInput[][] = [[raw()], [raw()], [raw()], [raw()]],
  rewrite = false,
  clustering = false,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dual-eval-test-"));
  const host = await loadConfig(path.join(ROOT, "configs/host.json"), {
    EVAL_BASE_URL: "http://127.0.0.1:1/v1",
  });
  const config = host.evaluation;
  config.comparisons = [["a_fast", "b_fast"]];
  config.rewrite = { comparison: rewrite, attribution: rewrite, clustering: rewrite };
  config.clustering = { ...config.clustering, enabled: clustering };
  config.output = { kind: "directory", path: path.join(directory, "runs") };
  config.problemLibrary = { kind: "directory", path: path.join(directory, "problems") };
  config.execution.retries = 0;
  config.execution.retryDelaySeconds = 0;
  config.execution.timeoutSeconds = 30;
  config.execution.idleTimeoutSeconds = 10;
  config.execution.concurrency = 2;
  for (const [i, version] of config.inputs.versions.entries()) {
    const file = path.join(directory, version.id + ".jsonl");
    version.sources = [{ kind: "file", path: file }];
    version.adapter = "a";
    await writeJsonl(file, rows[i] || []);
  }
  host.models.models.judge!.model = "fixture";
  host.models.models.judge!.thinking = "off";
  return {
    directory,
    config,
    models: host.models,
    modelForStage: createModelResolver(host.models),
  };
}

export function attributionResult(correct = true, answer = "2+2=4", available = true, inputId = "7c4e3ba8-8f7c-46cc-b8fb-3016e10ea2dd"): AttributionResult {
  return {
    has_standard_answer: available,
    is_correct: available ? correct : null,
    correctness_reason: available ? "与标准答案一致。" : "",
    numeric_checks: [],
    correctness_evidence: available ? [{ evidence_id: evidenceId(inputId, 1, "text", "/content", 0, answer.length), message_index: 1, quote: answer }] : [],
    task_analysis: criteriaResult({ question: "计算2+2", ground_truth: { available, value: available ? "4" : null },
      candidates: [{ candidate_id: inputId, instructions: [], context: [] }] }),
    criterion_assessments: [{ criterion_id: "r1", status: correct ? "met" : "unmet", evidence_status: "established",
      summary: correct ? "正确给出4。" : "结果错误。", evidence: [{ evidence_id: evidenceId(inputId, 1, "text", "/content", 0, answer.length), message_index: 1, quote: answer },
        { evidence_id: evidenceId(inputId, 0, "text", "/content", 0, 5), message_index: 0, quote: "计算2+2" }] }],
    core_assessment: { meets_core: correct, reason: correct ? "核心计算交付完成。" : "关键计算结果错误。", criterion_ids: ["r1"] },
    summary: correct ? "正确给出结果。" : "结果错误。",
    findings: [
      {
        finding_id: "f0",
        type: correct ? "strength" : "problem",
        dimension: "correctness",
        stage: "final_answer",
        importance: "high",
        text: correct ? "加法结果正确" : "加法结果错误",
        reason: "与题目要求一致。",
        evidence: [{ evidence_id: evidenceId(inputId, 1, "text", "/content", 0, answer.length), message_index: 1, quote: answer }],
        assessment: {
          requirement_index: 0,
          observation: answer,
          evidence_status: "established",
          impact: "决定加法要求是否完成。",
        },
        problem: correct
          ? null
          : { component: ["模型自身推理"], label: "算术错误", definition: "计算与事实不符。" },
      },
    ],
  };
}

/** Task result; Criteria uses its source-selection submission, other stages use resolved results. */
export function taskResult(spec: Pick<AttemptSpec, "evaluation" | "prompt" | "inputs">, revealed?: unknown): unknown {
  const properties =
    (spec.evaluation.outputSchema as { properties?: Record<string, unknown> }).properties || {};
  if ("rewrites" in properties) {
    const request = parsedMaterial(spec, revealed) as { items: { id: string; text: string; preference?: string }[] };
    return { rewrites: request.items.map((item) => ({ id: item.id, text: item.preference ? item.preference + "：核对了结果及具体交付。" : "精简：" + item.text })) };
  }
  if ("assignments" in properties) {
    const request = parsedMaterial(spec, revealed) as {
      library: { components: { classes: { id: string }[] }[] };
      items: { id: string; component: string; label: string }[];
    };
    const existing = request.library.components.flatMap((component) => component.classes)[0];
    if (!request.items.length) return { assignments: [], new_classes: [], merges: [] };
    if (existing)
      return {
        assignments: request.items.map((item) => ({ item_id: item.id, class_id: existing.id })),
        new_classes: [],
        merges: [],
      };
    const first = request.items[0]!;
    return {
      assignments: request.items.map((item) => ({ item_id: item.id, new_class_key: "n1" })),
      new_classes: [
        {
          key: "n1",
          component: first.component,
          label: first.label,
          definition: `${first.label}。`,
          closest_existing: null,
          novelty: "库为空，首次建立该类。",
        },
      ],
      merges: [],
    };
  }
  if ("requirements" in properties && !("task_analysis" in properties))
    return criteriaDraft((parsedMaterial(spec, revealed) as { source_catalog: CriterionSource[] }).source_catalog);
  const verification = verificationMaterial(spec, revealed);
  if (verification) {
    const { ranking_tiers, ...proposed } = verification.proposed.comparison_draft;
    return { ...structuredClone(proposed), task_analysis: verification.task.task,
      ranking: ranking_tiers.map(tier => [...tier.candidates]) };
  }
  if (!("answer" in materialOf(spec, revealed))) {
    const material = materialOf(spec, revealed), labels = Object.keys(material.candidates);
    const result = comparisonResult(labels);
    result.task_analysis = fixtureAnalysis(material.task_analysis, spec.inputs);
    for (const label of labels) {
      const failed = material.attributions?.[label]?.findings.some((finding) => finding.type === "problem" &&
        finding.importance === "high" && finding.assessment.evidence_status === "established" &&
        finding.assessment.requirement_index !== null);
      const core = material.attributions?.[label]?.core_assessment;
      result.assessments[label] = { meets_core: core?.meets_core ?? !failed,
        core_failure_refs: core?.meets_core === false ? core.criterion_ids : [], summary: failed ? "关键结果错误。" : "正确给出了结果。" };
    }
    result.decision_basis.comparisons = result.task_analysis.requirements.concat(result.task_analysis.scoring_points, result.task_analysis.red_flags)
      .map((criterion) => ({ aspect: criterion.text, criterion_ids: [criterion.id], importance: "high" as const, better_candidates: [],
        assessments: Object.fromEntries(labels.map((label) => {
          const source = material.attributions?.[label]?.criterion_assessments.find((item) => item.criterion_id === criterion.id);
          return [label, { status: source?.status ?? "met", evidence_status: source?.evidence_status ?? "established",
            summary: source?.summary ?? "已完成。", finding_indices: [0] }];
        })) }));
    result.ranking = [labels.filter((label) => result.assessments[label]!.meets_core),
      labels.filter((label) => !result.assessments[label]!.meets_core)].filter((tier) => tier.length);
    result.decision_basis.tradeoff = labels.every((label) => !result.assessments[label]!.meets_core)
      ? "双方关键结果均错误。" : "按关键结果的可用性比较。";
    return result;
  }
  const result = attributionResult(true, "2+2=4", true, spec.inputs.find(input => input.name === "answer")!.id);
  const material = materialOf(spec, revealed);
  result.task_analysis = fixtureAnalysis(material.task_analysis, spec.inputs);
  result.criterion_assessments = [...material.task_analysis.requirements, ...material.task_analysis.scoring_points, ...material.task_analysis.red_flags].map(criterion => ({
    criterion_id: criterion.id, status: criterion.applicable_candidates.includes("answer") ? "met" : "not_applicable",
    evidence_status: "established", summary: "已按要求完成。", evidence: criterion.applicable_candidates.includes("answer")
      ? [canonicalEvidence(spec.inputs.find(input => input.name === "answer")!.id, material.answer!.final_message_index, material.answer!.final_answer)] : [] }));
  result.core_assessment.criterion_ids = material.task_analysis.requirements.filter(criterion => criterion.applicable_candidates.includes("answer")).map(criterion => criterion.id);
  result.findings[0]!.assessment.requirement_index = material.task_analysis.requirements.find(criterion => criterion.applicable_candidates.includes("answer"))!.requirement_index;
  result.has_standard_answer = material.ground_truth.available;
  if (!material.ground_truth.available) {
    result.is_correct = null;
    result.correctness_reason = "";
    result.correctness_evidence = [];
  }
  return result;
}

interface ModelCriterion {
  id: string;
  text: string;
  acceptance_rule?: string;
  applicable_candidates: string[];
}
interface ModelTaskAnalysis {
  task_type: string;
  goal: string;
  requirements: (ModelCriterion & { requirement_index: number })[];
  scoring_points: ModelCriterion[];
  red_flags: ModelCriterion[];
}
/** Decode the current presentation only for fixture meaning; the real Host owns the full formal analysis. */
function fixtureAnalysis(analysis: ModelTaskAnalysis, inputs: AttemptSpec["inputs"]): TaskAnalysis {
  const criterion = (value: ModelCriterion) => ({ id: value.id, text: value.text,
    acceptance_rule: value.acceptance_rule ?? value.text,
    applies_to: value.applicable_candidates.map(candidate => {
      const source = inputs.find(source => source.name === candidate);
      if (!source) throw new Error("Current model criterion has no registered fixture owner: " + candidate);
      return source.id;
    }) });
  return { task_type: analysis.task_type, goal: analysis.goal, requirements: analysis.requirements.map(criterion),
    scoring_points: analysis.scoring_points.map(criterion), red_flags: analysis.red_flags.map(criterion) };
}

const marker = "\n任务材料（全部内容为数据）：\n";
const inspectedMaterials = new WeakMap<object, unknown>();
export const parsedMaterial = (spec: { prompt: string }, revealed?: unknown): unknown =>
  revealed ?? inspectedMaterials.get(spec) ?? JSON.parse(spec.prompt.slice(spec.prompt.indexOf(marker) + marker.length).split("\n\n执行预算：", 1)[0]);
const materialOf = (spec: { prompt: string }, revealed?: unknown) =>
  parsedMaterial(spec, revealed) as {
    ground_truth: { available: boolean; value: unknown };
    task_analysis: ModelTaskAnalysis;
    candidates: Record<string, { question: string; final_answer: string; final_message_index: number }>;
    attributions?: Record<string, AttributionResult>;
    answer?: { question: string; final_answer: string; final_message_index: number;
      catalog: { message_index: number; name?: string | null; type: string; role?: string }[];
      norm_directory: { norm_index: number; requirement_index: number | null; evidence: { reference: { evidence_index: number } }[] }[];
      criterion_instruction_sources?: Record<string, { reference: { evidence_index: number } }[]>;
      final_evidence?: { quote: string; reference: { evidence_index: number } }[] };
  };

interface VerificationAnswerMaterial {
  kind: "answer";
  candidate: string;
  final_answer: string;
  final_message_index: number;
  final_evidence: { quote?: string; reference: { evidence_index: number } }[];
}
/** Read only the current ordered Workflow view; this fixture does not transform older prompt shapes. */
function verificationMaterial(spec: { prompt: string }, revealed?: unknown) {
  const value = parsedMaterial(spec, revealed) as { sections?: [
    { kind: "original_materials"; materials: [{ kind: "task"; task: TaskAnalysis; ground_truth: unknown }, ...VerificationAnswerMaterial[]] },
    { kind: "source_directory" },
    { kind: "proposed_comparison"; comparison_draft: Omit<ComparisonResult, "task_analysis" | "ranking"> & {
      ranking_tiers: { tier: number; candidates: string[]; relation: "same_tier" }[] } },
  ] };
  if (!value.sections) return undefined;
  const [original, directory, proposed] = value.sections;
  if (!proposed) throw new Error("Verification fixture must inspect actual materials before accessing upstream decisions");
  if (original.kind !== "original_materials" || directory.kind !== "source_directory" || proposed.kind !== "proposed_comparison")
    throw new Error("Invalid current verification fixture view");
  const [task, ...answers] = original.materials;
  return { task, answers, proposed };
}

/** A controlled source-only inspection; it cannot read the upstream rubric assessments or draft. */
export function inspectionDraft(spec: { prompt: string }): unknown {
  const value = JSON.parse(spec.prompt.slice(spec.prompt.indexOf(marker) + marker.length).split("\n\n执行预算：", 1)[0]) as {
    sections: [{ kind: "original_materials"; materials: [{ kind: "task"; question: string;
      ground_truth: { available: boolean; value: unknown } }, ...VerificationAnswerMaterial[]] },
      { kind: "source_directory"; verification_check_slots: { candidate: string; requirement_index: number; criterion: { text: string } }[] }];
  };
  const [original, directory] = value.sections;
  if (value.sections.length !== 2 || original.kind !== "original_materials" || directory.kind !== "source_directory")
    throw new Error("Inspection fixture requires the original blind source-only view");
  const [task, ...answers] = original.materials;
  const concerns: { candidate: string; requirement_indices: number[]; answer_evidence: unknown[]; source_evidence: unknown[]; reason: string }[] = [];
  const checks = directory.verification_check_slots.map(slot => {
    const answer = answers.find(answer => answer.candidate === slot.candidate)!;
    const wrongSum = task.question === "计算2+2" && task.ground_truth.available &&
      (task.ground_truth.value === "4" || task.ground_truth.value === "4（整数）") && answer.final_answer === "2+2=5" &&
      [task.question, task.ground_truth.value].some(source => hasSourceTextBlock(slot.criterion.text, source));
    if (wrongSum && !concerns.some(concern => concern.candidate === slot.candidate && concern.requirement_indices.includes(slot.requirement_index)))
      concerns.push({ candidate: slot.candidate, requirement_indices: [slot.requirement_index],
        answer_evidence: [structuredClone(answer.final_evidence.find(evidence => evidence.quote === answer.final_answer)!.reference)],
        source_evidence: [], reason: "原题计算2+2，标准答案为4，实际回答2+2=5与加法结果不符。" });
    return { result: wrongSum ? "contradicted" : "supported", source_evidence: [],
      observation: wrongSum ? "原题计算2+2，标准答案为4，实际回答2+2=5与加法结果不符。" :
        "逐项核对受控测试中的实际回答与登记要求。" };
  });
  return { checks, concerns };
}

/** Mock backends use the current profile transport; every queued file owns distinct bytes. */
export async function submitFor(options: Parameters<AgentBackend["createSession"]>[0], value: unknown) {
  if (!options.spec.evaluation.fileSubmission) return options.execute("submit_evaluation", value);
  const file = `evaluation-${randomUUID()}.json`;
  await writeJson(path.join(options.workdir, file), value);
  return options.execute("submit_evaluation_file", { path: file });
}

export async function inspectMaterials(options: Parameters<AgentBackend["createSession"]>[0], value: unknown) {
  if (!options.spec.evaluation.fileSubmission) return options.execute("inspect_material", value);
  await writeJson(path.join(options.workdir, "inspection.json"), value);
  return options.execute("inspect_material", { path: "inspection.json" });
}
export async function inspectFor(options: Parameters<AgentBackend["createSession"]>[0]): Promise<boolean> {
  if (!options.spec.evaluation.inspectionSchema || inspectedMaterials.has(options.spec)) return false;
  if (options.spec.recovery?.inspection) {
    if (!verificationMaterial(options.spec)) throw new Error("Restored inspection lacks disclosed material");
    return false;
  }
  const result = await inspectMaterials(options, inspectionDraft(options.spec));
  if (result.isError) throw new Error(JSON.stringify(result));
  const value = JSON.parse(result.content.find(item => item.type === "text")!.text!) as Record<string, unknown>;
  if (value.accepted !== true || !value.material) throw new Error("Inspection did not reveal trusted material");
  inspectedMaterials.set(options.spec, value.material);
  if (!verificationMaterial(options.spec)) throw new Error("Inspection reply lacks current comparison material");
  return true;
}

/** Build the current model submission, using provided evidence choices and omitting program-derived fields. */
export function draftFor(spec: Pick<AttemptSpec, "inputs" | "prompt" | "evidenceBank">, value: unknown, revealed?: unknown): unknown {
  const result = structuredClone(value) as Record<string, unknown>;
  if (!result || typeof result !== "object") return result;
  const material = materialOf(spec, revealed);
  const verification = verificationMaterial(spec, revealed);
  if (verification) {
    const current = material as unknown as { inspection_context: { eligible_match_choices: {
      concern_index: number; eligible_findings: { finding_index: number }[]; complete_coverage_possible: boolean;
    }[] } };
    const concern_matches = current.inspection_context.eligible_match_choices.flatMap(choice =>
      choice.complete_coverage_possible && choice.eligible_findings.length ? [{ concern_index: choice.concern_index,
        finding_indices: choice.eligible_findings.map(finding => finding.finding_index),
        observation: "既有问题引用本方同一要求及同一完整实际回答，记录了盲核查发现的加法错误。" }] : []);
    return { concern_matches, concern_refutations: [], source_reviews: [] };
  }
  if ("source_catalog" in material) return result;
  if ("assignments" in result) {
    // Current canonical keys remain in library decisions; the model selects array positions.
    const classes = result.new_classes as ({ key: string } & Record<string, unknown>)[];
    result.assignments = (result.assignments as ({ new_class_key?: string } & Record<string, unknown>)[])
      .map(({ new_class_key, ...assignment }) => {
        if (new_class_key === undefined) return assignment;
        const new_class_index = classes.findIndex(proposal => proposal.key === new_class_key);
        if (new_class_index < 0) throw new Error("Fixture assignment must bind a declared canonical new class");
        return { ...assignment, new_class_index };
      });
    result.new_classes = classes.map(({ key: _programIdentity, ...proposal }) => proposal);
    return result;
  }
  const choose = (id: string, observation?: string) => {
    const target = parseEvidenceCoordinates(id)!;
    const index = spec.evidenceBank.findIndex(id => {
      const entry = parseEvidenceCoordinates(id);
      return entry?.input_id === target.input_id && entry.message_index === target.message_index && entry.kind === target.kind &&
        (entry.kind === "image" || target.kind !== "image" && entry.path === target.path && entry.start <= target.start && entry.end >= target.end);
    });
    if (index < 0) throw new Error("Fixture must read material before selecting an unavailable span");
    return { evidence_index: index + 1, ...(observation === undefined ? {} : { observation }) };
  };
  const evidence = (items: unknown) =>
    (items as { evidence_id: string; quote: string }[]).map(item => {
      const coordinate = parseEvidenceCoordinates(item.evidence_id);
      return choose(item.evidence_id, coordinate?.kind === "image" ? item.quote.slice("[图像观察]".length) : undefined);
    });
  if (material.answer && "findings" in result) {
    // The Host, not the model, supplies the standard-answer flag on the accepted result.
    delete result.has_standard_answer;
    delete result.task_analysis;
    const core = result.core_assessment as AttributionResult["core_assessment"];
    result.core_assessment = { meets_core: core.meets_core, reason: core.reason,
      requirement_indices: core.criterion_ids.map(id => {
        const criterion = material.task_analysis.requirements.find(criterion => criterion.id === id);
        if (!criterion || !criterion.applicable_candidates.includes("answer"))
          throw new Error("Fixture core must select an applicable requirement from the current model directory");
        return criterion.requirement_index;
      }) };
    if (!material.ground_truth.available) {
      delete result.is_correct;
      delete result.correctness_reason;
      delete result.correctness_evidence;
    } else result.correctness_evidence = evidence(result.correctness_evidence);
    result.criterion_assessments = (result.criterion_assessments as Record<string, unknown>[])
      .filter(item => item.status !== "not_applicable");
    (result.criterion_assessments as Record<string, unknown>[]).forEach((item) => { item.evidence = evidence(item.evidence); });
    const sourceRefs = (items: { reference: { evidence_index: number } }[]) => items.map(item => {
      const evidence_id = spec.evidenceBank[item.reference.evidence_index - 1];
      if (!evidence_id) throw new Error("Fixture norm must select a registered exact origin");
      return { evidence_id };
    });
    const norms = material.answer!.norm_directory.map(norm => ({ ...norm, evidence: sourceRefs(norm.evidence) }));
    (result.findings as unknown as Record<string, unknown>[]).forEach((finding) => {
      if (finding.dimension === "instruction_following") {
        finding.norm_index = normSelection(norms, finding as unknown as AttributionResult["findings"][number]);
        const { requirement_index: _derived, ...assessment } = finding.assessment as AttributionResult["findings"][number]["assessment"];
        finding.assessment = assessment;
      }
      delete finding.finding_id;
      if (finding.type === "strength") delete finding.problem;
      else finding.problem = problemSubmission(finding.problem as NonNullable<AttributionResult["findings"][number]["problem"]>,
        finding.evidence as AttributionResult["correctness_evidence"], material.answer!.catalog);
      finding.evidence = evidence(finding.evidence);
    });
    return result;
  }
  if ("assessments" in result) {
    const choices = (material as unknown as { comparison_slots: { aspect:string; scope:string; optional:boolean; kind:ComparisonSlot["kind"];
      standards:{text:string}[]; observations:Record<string,{text:string}[]> }[] }).comparison_slots;
    if (!choices) throw new Error("Comparison fixture requires its program slot directory");
    const analysis = fixtureAnalysis(material.task_analysis, spec.inputs);
    const criteria = [...analysis.requirements,...analysis.scoring_points,...analysis.red_flags];
    const slots: ComparisonSlot[] = choices.map(choice => ({ aspect:choice.aspect,kind:choice.kind,optional:choice.optional,shared:choice.scope === "pair",
      criterion_ids:choice.standards.map(standard => criteria.find(criterion => criterion.text === standard.text)!.id),
      finding_indices:Object.fromEntries(Object.entries(choice.observations).map(([candidate,observations]) => [candidate,
        observations.map(observation => (material.attributions?.[candidate]?.findings ?? []).findIndex((finding:{text:string}) => finding.text === observation.text))])) }));
    return comparisonSubmission(result as unknown as ComparisonResult,slots);
  }
  return result;
}

/** A complete current submission whose first finding selects beyond the provided bank. */
export function invalidDraft(spec: Pick<AttemptSpec, "evaluation" | "inputs" | "prompt" | "evidenceBank">): unknown {
  const draft = draftFor(spec, taskResult(spec)) as { findings: { evidence: { evidence_index: number }[] }[] };
  draft.findings[0].evidence[0].evidence_index = Number.MAX_SAFE_INTEGER;
  return draft;
}

/** Create hand-seeded restore receipts through the same public inspection and acceptance gates as live tasks. */
export async function inspectedReceiptFor(task: PlannedTask, state: RunState, inputs: Record<string, unknown>): Promise<SubmissionReceipt> {
  const { RunStore } = await import("@eval/host");
  const { services } = await import("./services.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "inspection-receipt-test-"));
  const scratch = structuredClone(state);
  delete scratch.receipts[task.id];
  scratch.manifest.states[task.id] = { status: "pending", attempts: 0 };
  scratch.manifest.engine = fakeIdentity;
  scratch.manifest.evaluatorVersion = fakeEvaluatorVersion;
  const store = new RunStore(directory, scratch, inputs, services);
  try {
    const dependencies = Object.fromEntries(Object.entries(task.dependencies).map(([key, id]) => [key, scratch.receipts[id]]));
    const binding = comparisonWorkflow.bind(task, inputs, dependencies, { tasks: scratch.manifest.tasks });
    const prepared = services.agents.prepare(binding);
    const spec: AttemptSpec = { ...prepared, taskId: task.id, attemptId: crypto.randomUUID(), runId: scratch.manifest.runId,
      inputRevision: 1, engine: fakeIdentity, model: { provider: "fixture", baseUrl: "http://127.0.0.1:1", api: "openai-completions",
        apiKeyEnv: "FIXTURE_KEY", model: fakeJudge, thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 },
      policy: DEFAULT_POLICY, inputs: Object.entries(task.inputIds).map(([name, id]) => ({ name, id })),
      deadline: Date.now() + 60000, hostUrl: "http://127.0.0.1:1" };
    await store.activate(spec);
    const audit: ToolAudit = { ...emptyAudit(), evidenceBank: [...prepared.evidenceBank] };
    const inspected = await store.inspect({ taskId: task.id, attemptId: spec.attemptId, inspectionId: crypto.randomUUID(),
      value: inspectionDraft(spec) as import("@eval/contracts").JsonObject, audit, contentSubmissions: 1 });
    audit.inspection = inspected.inspection;
    audit.evidenceBank = [...inspected.evidenceBank];
    const receipt = await store.accept({ taskId: task.id, attemptId: spec.attemptId, submissionId: crypto.randomUUID(),
      evaluation: draftFor(spec, taskResult(spec, inspected.material), inspected.material), audit, usage: emptyUsage(),
      submissionStats: { contentSubmissions: 2, fileErrors: 0 } });
    const complete = structuredClone(receipt);
    delete complete.exported;
    return complete;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
