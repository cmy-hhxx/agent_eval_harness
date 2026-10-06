import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ValidationError, type PlannedTask, type WorkflowDefinition } from "@eval/contracts";
import { attributionProfile, type AttributionResult } from "@eval/agents/attribution";
import { comparisonScope } from "@eval/agents/comparison";
import type { TaskData } from "./types.js";
import { bindTask } from "./binding.js";

/** Accepted answers are reused when their original standard is exactly the new shared standard. */
const advanceCriteria: NonNullable<WorkflowDefinition["advance"]> = (task, receipt, state, inputs) => {
  const data = task.data as TaskData, tasks: PlannedTask[] = [], replace = new Map<string, PlannedTask>();
  const reviews = new Map<string, PlannedTask>();
  for (const comparison of state.manifest.tasks.filter((item) => item.stage === "comparison" &&
    item.dependencies.criteria === task.id && !state.receipts[item.id])) {
    const compared = comparison.data as TaskData, deps = { ...comparison.dependencies };
    for (const [label, candidate] of Object.entries(compared.candidates)) {
      const sourceId = deps[label]!, source = state.receipts[sourceId];
      if (!source) continue;
      const original = state.manifest.tasks.find((item) => item.id === sourceId)!;
      const evaluation = source.evaluation as { task_analysis?: unknown; core_assessment?: unknown; criterion_assessments?: unknown };
      if (isDeepStrictEqual(evaluation.task_analysis, receipt.evaluation) && evaluation.core_assessment &&
        Array.isArray(evaluation.criterion_assessments) && isDeepStrictEqual((original.data as TaskData).reference, data.reference)) {
        const check: PlannedTask = { ...original, inputIds: { answer: candidate.input_id }, dependencies: { criteria: task.id },
          data: { ...(original.data as TaskData), candidates: { A: candidate }, reference: data.reference } satisfies TaskData };
        try {
          attributionProfile.validate!(bindTask(check, inputs, { criteria: receipt }, { tasks: state.manifest.tasks }).request, source.evaluation, source.audit);
          continue;
        } catch (error) { if (!(error instanceof ValidationError)) throw error; }
      }
      let review = reviews.get(sourceId);
      if (!review) {
        review = { id: randomUUID(), stage: "attribution", dependencies: { criteria: task.id }, inputIds: { answer: candidate.input_id },
          data: { stage: "attribution", candidates: { A: candidate }, reference: data.reference, criteriaScope: data.criteriaScope,
            initialContextChars: compared.initialContextChars, revision: 1,
            ...((original.data as TaskData).reviewQuestions ? { reviewQuestions: [...(original.data as TaskData).reviewQuestions!] } : {}),
            reviewOf: { taskId: sourceId, round: 1, reasons: ["本次共同标准、标准答案或当前材料证据与原归因不一致，按本次材料独立核验。"] } } satisfies TaskData };
        reviews.set(sourceId, review); tasks.push(review);
        const polish = state.manifest.tasks.find((item) => item.stage === "rewrite" && item.dependencies.source === sourceId);
        if (polish) tasks.push({ ...polish, id: randomUUID(), dependencies: { source: review.id },
          data: { ...(polish.data as TaskData), rewriteOf: { stage: "attribution", taskId: review.id, resultId: review.id }, revision: 1 } satisfies TaskData });
      }
      deps[label] = review.id;
      for (const cluster of state.manifest.tasks.filter((item) => item.stage === "clustering" && !state.receipts[item.id])) {
        const current = replace.get(cluster.id) ?? cluster;
        if (current.dependencies[candidate.input_id] === sourceId)
          replace.set(cluster.id, { ...current, dependencies: { ...current.dependencies, [candidate.input_id]: review.id } });
      }
    }
    if (!isDeepStrictEqual(deps, comparison.dependencies)) replace.set(comparison.id, { ...comparison, dependencies: deps });
  }
  return { tasks, replace: [...replace.values()] };
};

/** Before the first comparison, ask both source agents once about unmatched material observations. */
const advanceCoverage: NonNullable<WorkflowDefinition["advance"]> = (task, _receipt, state, inputs) => {
  const tasks: PlannedTask[] = [], replace: PlannedTask[] = [];
  for (const comparison of state.manifest.tasks.filter(item => item.stage === "comparison" &&
    !(item.data as TaskData).verificationAudit && !(item.data as TaskData).coverageReviewPrepared &&
    Object.values(item.dependencies).includes(task.id) && !state.receipts[item.id] &&
    Object.values(item.dependencies).every(id => state.receipts[id]))) {
    const data = comparison.data as TaskData;
    const dependencies = Object.fromEntries(Object.entries(comparison.dependencies).map(([key,id]) => [key,state.receipts[id]]));
    const binding = bindTask(comparison,{...inputs},dependencies,{tasks:state.manifest.tasks});
    const scope = comparisonScope(binding.request);
    const observations = Object.keys(data.candidates).flatMap(label => {
      const attribution = dependencies[label].evaluation as AttributionResult;
      return attribution.findings.flatMap((finding,index) => finding.type === "problem" && finding.assessment.requirement_index === null &&
        finding.importance !== "low" && scope.findings[label][index].scope === "pair" ? [finding.text] : []);
    });
    if (!observations.length) continue;
    const next = { ...comparison.dependencies };
    for (const [label,candidate] of Object.entries(data.candidates)) {
      const original = state.manifest.tasks.find(item => item.id === comparison.dependencies[label])!;
      const id = randomUUID();
      const review: PlannedTask = { id,stage:"attribution",inputIds:{answer:candidate.input_id},dependencies:{criteria:comparison.dependencies.criteria},
        data:{stage:"attribution",candidates:{A:candidate},reference:data.reference,criteriaScope:data.criteriaScope,group:data.group,coverageReview:true,
          initialContextChars:data.initialContextChars,revision:1,reviewOf:{taskId:original.id,round:1,
            reasons:["核查以下同题比较点在本方回答中的实际表现；这些观察不是本方既定事实。确实涉及某项共同交付时，将本方 finding 关联对应要求并同步逐项状态；私规不扩大为共同要求，无关内容不强行关联。",...new Set(observations)]}} satisfies TaskData };
      if ((original.data as TaskData).reviewQuestions)
        (review.data as TaskData).reviewQuestions = [...(original.data as TaskData).reviewQuestions!];
      tasks.push(review); next[label]=id;
      const polish = state.manifest.tasks.find(item => item.stage === "rewrite" && item.dependencies.source === original.id);
      if(polish) tasks.push({...polish,id:randomUUID(),dependencies:{source:id},data:{...(polish.data as TaskData),
        rewriteOf:{stage:"attribution",taskId:id,resultId:id},revision:1} satisfies TaskData});
    }
    replace.push({...comparison,dependencies:next,data:{...data,coverageReviewPrepared:true} satisfies TaskData});
  }
  if ((task.data as TaskData).coverageReview) for (const cluster of state.manifest.tasks.filter(item => item.stage === "clustering" &&
    !state.receipts[item.id] && state.manifest.states[item.id]?.status !== "running")) {
    const inputId=task.inputIds.answer;
    if(Object.hasOwn(cluster.dependencies,inputId)) replace.push({...cluster,dependencies:{...cluster.dependencies,[inputId]:task.id}});
  }
  return {tasks,replace};
};

/** Accepted formal comparisons and retrospective verification never reopen source results. */
export const advanceReview: NonNullable<WorkflowDefinition["advance"]> = (task, receipt, state, inputs) =>
  task.stage === "criteria" ? advanceCriteria(task, receipt, state, inputs)
    : task.stage === "attribution" ? advanceCoverage(task, receipt, state, inputs) : { tasks: [] };
