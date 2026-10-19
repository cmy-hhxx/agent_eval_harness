import { canonical, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import type { AttributionResult, TaskData } from "./types.js";

export type ResponsibilityGroup = "model" | "mixed" | "other" | "unknown" | "unconfirmed";
export const responsibilityLabels: Record<ResponsibilityGroup, string> = {
  model: "模型独立责任", mixed: "模型参与的混合责任", other: "其他已知责任", unknown: "未知责任", unconfirmed: "未确认",
};
interface SourceReference { task_id: string; submission_id: string; evaluator_version: string }
export interface ModelBehaviorFinding {
  finding_id: string;
  responsibility: ResponsibilityGroup;
  components: string[];
  text: string;
  impact: string;
  source_conflict: boolean;
  sources: SourceReference[];
}
export interface ModelBehaviorRow {
  input_id: string;
  batch_id: string;
  case_id: string;
  version: string;
  sources: SourceReference[];
  findings: ModelBehaviorFinding[];
}
const emptyCounts = (): Record<ResponsibilityGroup, number> => ({ model: 0, mixed: 0, other: 0, unknown: 0, unconfirmed: 0 });
function flagSourceConflict(finding: ModelBehaviorFinding) {
  finding.responsibility = "unconfirmed";
  finding.source_conflict = true;
  finding.text = "同一发现坐标的来源描述不一致，需复核各条原归因。";
  finding.impact = "来源存在分歧，暂不合并为已确认责任。";
}

/** A responsibility view of accepted problems, independent of comparative wins and strength counts. */
export function modelBehavior(tasks: readonly PlannedTask[], receipts: Readonly<Record<string, SubmissionReceipt>>) {
  const comparisons = tasks.filter(task => task.stage === "comparison" && !(task.data as TaskData).verificationAudit);
  const referenced = new Set(comparisons.flatMap(task => Object.keys((task.data as TaskData).candidates).map(label => task.dependencies[label])));
  const comparedInputs = new Set(comparisons.flatMap(task => Object.values(task.inputIds)));
  const attributionTasks = tasks.filter(task => task.stage === "attribution");
  const byId = new Map(attributionTasks.map(task => [task.id, task]));
  // A consumer can already point to a pending review; retain its last accepted same-input source.
  for (const id of [...referenced]) {
    let source = byId.get(id);
    const inputId = source?.inputIds.answer, visited = new Set<string>();
    while (source && !receipts[source.id] && !visited.has(source.id)) {
      visited.add(source.id);
      const parentId = (source.data as TaskData).reviewOf?.taskId;
      const parent = parentId && byId.get(parentId);
      if (!parent || parent.inputIds.answer !== inputId) break;
      source = parent;
    }
    if (source && receipts[source.id]) referenced.add(source.id);
  }
  const candidates = attributionTasks.filter(task =>
    (!comparedInputs.has(task.inputIds.answer) || referenced.has(task.id)));
  const superseded = new Set<string>();
  for (const task of candidates) {
    if (!receipts[task.id]) continue;
    let sourceId = (task.data as TaskData).reviewOf?.taskId;
    while (sourceId && !superseded.has(sourceId)) {
      const source = byId.get(sourceId);
      if (!source || source.inputIds.answer !== task.inputIds.answer) break;
      superseded.add(sourceId);
      sourceId = (source.data as TaskData).reviewOf?.taskId;
    }
  }
  const attributions = candidates.filter(task => !superseded.has(task.id));
  const planned = new Set(attributions.map(task => task.inputIds.answer));
  const rows = new Map<string, ModelBehaviorRow>();
  const strengths = new Map<string, SourceReference[]>();
  for (const task of attributions) {
    const receipt = receipts[task.id];
    if (!receipt) continue;
    const candidate = (task.data as TaskData).candidates.A;
    const source = { task_id: task.id, submission_id: receipt.submissionId, evaluator_version: receipt.evaluatorVersion };
    let row = rows.get(candidate.input_id);
    if (!row) rows.set(candidate.input_id, row = { input_id: candidate.input_id, batch_id: candidate.batch_id,
      case_id: candidate.case_id, version: candidate.version, sources: [], findings: [] });
    row.sources.push(source);
    for (const finding of (receipt.evaluation as AttributionResult).findings) {
      if (finding.type === "strength") {
        const key = canonical([candidate.input_id, finding.finding_id]);
        strengths.set(key, [...(strengths.get(key) ?? []), source]);
      }
      if (finding.type !== "problem" || !finding.problem) continue;
      const components = [...new Set(finding.problem.component)].sort();
      const responsibility: ResponsibilityGroup = finding.assessment.evidence_status !== "established" ? "unconfirmed"
        : !components.length ? "unknown" : components.includes("模型自身推理")
          ? components.length === 1 ? "model" : "mixed" : "other";
      const observation = { finding_id: finding.finding_id, responsibility, components, text: finding.text,
        impact: finding.assessment.impact, source_conflict: false };
      const existing = row.findings.find(item => item.finding_id === finding.finding_id);
      if (!existing) row.findings.push({ ...observation, sources: [source] });
      else {
        const { sources: _sources, ...previous } = existing;
        if (canonical(previous) !== canonical(observation)) {
          flagSourceConflict(existing);
          existing.components = [...new Set([...existing.components, ...components])].sort();
        }
        if (!existing.sources.some(item => item.submission_id === source.submission_id)) existing.sources.push(source);
      }
    }
  }
  for (const row of rows.values()) for (const finding of row.findings) {
    const counterSources = strengths.get(canonical([row.input_id, finding.finding_id]));
    if (!counterSources) continue;
    flagSourceConflict(finding);
    for (const source of counterSources)
      if (!finding.sources.some(item => item.submission_id === source.submission_id)) finding.sources.push(source);
  }
  const byVersion: Record<string, { planned_answers: number; accepted_answers: number; problems: Record<ResponsibilityGroup, number> }> = {};
  for (const task of attributions) {
    const version = (task.data as TaskData).candidates.A.version;
    byVersion[version] ??= { planned_answers: 0, accepted_answers: 0, problems: emptyCounts() };
  }
  for (const inputId of planned) {
    const task = attributions.find(item => item.inputIds.answer === inputId)!;
    byVersion[(task.data as TaskData).candidates.A.version].planned_answers++;
  }
  for (const row of rows.values()) {
    const summary = byVersion[row.version];
    summary.accepted_answers++;
    for (const finding of row.findings) summary.problems[finding.responsibility]++;
  }
  return { rows: [...rows.values()].sort((a, b) => canonical([a.batch_id, a.case_id, a.version]).localeCompare(canonical([b.batch_id, b.case_id, b.version]))),
    summary: { planned_answers: planned.size, accepted_answers: rows.size, by_version: byVersion } };
}

export function modelBehaviorDetails(rows: readonly ModelBehaviorRow[]): string[] {
  if (!rows.length) return [];
  return ["# 模型行为归因结论", "", "以下说明本次任务中的已接受归因，不代表底座能力排名；未标注责任的优点不自动归功于模型。", "",
    ...rows.flatMap(row => [`## ${row.batch_id} / ${row.case_id} / ${row.version}`, "",
      ...(row.findings.length ? row.findings.map(finding => `- **${responsibilityLabels[finding.responsibility]}**：${finding.text}` +
        (finding.impact ? ` ${finding.impact}` : "") + `（发现 ${finding.finding_id}；来源任务 ${finding.sources.map(source => source.task_id).join("、")}）`)
        : ["未记录问题归因；这不证明没有错误或模型能力更强。"]), ""])];
}

export function modelBehaviorOverview(summary: ReturnType<typeof modelBehavior>["summary"] | undefined): string {
  if (!summary) return "";
  const cell = (value: string) => value.replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
  return "\n\n## 模型行为归因结论\n\n" +
    `已接受归因覆盖 ${summary.accepted_answers}/${summary.planned_answers} 条回答；按回答与发现去重，混合责任只计一次。\n\n` +
    "| 版本 | 已接受/计划回答 | 模型独立责任 | 模型混合责任 | 其他责任 | 未知责任 | 未确认 |\n|---|---:|---:|---:|---:|---:|---:|\n" +
    Object.entries(summary.by_version).map(([version, value]) => `| ${cell(version)} | ${value.accepted_answers}/${value.planned_answers} | ` +
      `${value.problems.model} | ${value.problems.mixed} | ${value.problems.other} | ${value.problems.unknown} | ${value.problems.unconfirmed} |`).join("\n") +
    "\n\n[具体行为与归因来源](model-behavior.jsonl) · [逐题说明](task_summaries.md#模型行为归因结论)\n\n" +
    "产品效果与责任归因是两个评价角度，共享同一批证据；问题数量不构成底座能力排名。";
}
