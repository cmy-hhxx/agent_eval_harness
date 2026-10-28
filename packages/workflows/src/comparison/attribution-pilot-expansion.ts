import { canonical } from "@eval/contracts";
import { runLock } from "@eval/data";
import { readRunState, writeRunState } from "./run-data.js";
import { supersededAttributionRewriteIds } from "./attribution-rewrite-planning.js";
import type { AttributionJobConfig } from "./attribution-job.js";
import type { TaskData } from "./types.js";

/** Expand only the saved pilot's answer selection; task identities and accepted work remain intact. */
export async function prepareAttributionPilotExpansion(run: string, options: { answersPerModel: number; apply?: boolean }) {
  if (!Number.isSafeInteger(options.answersPerModel) || options.answersPerModel < 1) throw new Error("answersPerModel 必须为正整数");
  const release = await runLock(run);
  try {
    const state = await readRunState(run), manifest = state.manifest, config = manifest.config as AttributionJobConfig;
    if (!config.attributionJob || !manifest.executionScope) throw new Error("只能扩大已有独立归因作业的冻结试跑范围");
    const models = config.inputs.versions.map(version => version.id);
    const attributions = manifest.tasks.filter(task => task.stage === "attribution-session"), allByTask = new Map(manifest.tasks.map(task => [task.id, task]));
    const answers = attributions.filter(task => !(task.data as TaskData).reviewOf).map(task => {
      const data = task.data as TaskData, candidate = data.candidates.A;
      return { task, candidate, standard: data.reference !== null };
    });
    const byInput = new Map(answers.map(answer => [answer.candidate.input_id, answer]));
    if (new Set(answers.map(answer => answer.candidate.input_id)).size !== answers.length) throw new Error("冻结计划的回答身份重复");
    if (answers.some(answer => !models.includes(answer.candidate.version) ||
      (config.attributionJob.fromBatch && answer.candidate.batch_id < config.attributionJob.fromBatch)))
      throw new Error("冻结计划的回答超出原模型或日期范围");
    const previous = manifest.preflight.selected_answers as { task_id: string; input_id: string; version: string; batch_id: string; case_id: string }[];
    if (!Array.isArray(previous) || !previous.length) throw new Error("冻结试跑缺少已选择回答索引");
    const selected = previous.map(item => {
      const task = allByTask.get(item.task_id), answer = task && byInput.get((task.data as TaskData).candidates.A.input_id);
      if (!answer || canonical([answer.candidate.input_id, answer.candidate.version, answer.candidate.batch_id, answer.candidate.case_id]) !==
        canonical([item.input_id, item.version, item.batch_id, item.case_id])) throw new Error("试跑回答索引与冻结任务不一致：" + item.task_id);
      return answer;
    });
    const ids = new Set(selected.map(answer => answer.task.id));
    if (ids.size !== selected.length) throw new Error("试跑回答索引重复");
    for (const model of models) {
      if (answers.filter(answer => answer.candidate.version === model).length < options.answersPerModel)
        throw new Error(`模型 ${model} 不足 ${options.answersPerModel} 份回答`);
      if (selected.filter(answer => answer.candidate.version === model).length > options.answersPerModel)
        throw new Error("不能收缩已有试跑范围：" + model);
    }
    const dates = new Map<string, number>(), counts = new Map<string, number>(), standards = new Map<boolean, number>(), cases = new Map<string, number>();
    const account = (answer: typeof answers[number]) => {
      const candidate = answer.candidate, caseKey = canonical([candidate.batch_id, candidate.case_id]);
      dates.set(candidate.batch_id, (dates.get(candidate.batch_id) ?? 0) + 1);
      counts.set(candidate.version, (counts.get(candidate.version) ?? 0) + 1);
      standards.set(answer.standard, (standards.get(answer.standard) ?? 0) + 1);
      cases.set(caseKey, (cases.get(caseKey) ?? 0) + 1);
    };
    selected.forEach(account);
    const strata = new Map<string, typeof answers>();
    for (const answer of answers) {
      const stratum = canonical([answer.candidate.batch_id, answer.candidate.version, answer.standard]);
      strata.set(stratum, [...strata.get(stratum) ?? [], answer]);
    }
    const queues = [...strata.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => ({ key, answers: values.filter(answer => !ids.has(answer.task.id)) }));
    while (selected.length < models.length * options.answersPerModel) {
      const queue = queues.filter(queue => queue.answers.length && (counts.get(queue.answers[0].candidate.version) ?? 0) < options.answersPerModel).sort((a, b) => {
        const x = a.answers[0], y = b.answers[0];
        return (dates.get(x.candidate.batch_id) ?? 0) - (dates.get(y.candidate.batch_id) ?? 0) ||
          (counts.get(x.candidate.version) ?? 0) - (counts.get(y.candidate.version) ?? 0) ||
          (standards.get(x.standard) ?? 0) - (standards.get(y.standard) ?? 0) || a.key.localeCompare(b.key);
      })[0];
      if (!queue) throw new Error("冻结计划无法满足各模型独立配额");
      const caseCount = (answer: typeof answers[number]) => cases.get(canonical([answer.candidate.batch_id, answer.candidate.case_id])) ?? 0;
      const minimum = Math.min(...queue.answers.map(caseCount)), eligible = queue.answers.filter(answer => caseCount(answer) === minimum);
      const answer = eligible[Math.floor(eligible.length / 2)];
      queue.answers.splice(queue.answers.indexOf(answer), 1); selected.push(answer); ids.add(answer.task.id); account(answer);
    }
    const related = new Map<string, typeof attributions>();
    for (const task of attributions) {
      const input = (task.data as TaskData).candidates.A.input_id;
      related.set(input, [...related.get(input) ?? [], task]);
    }
    const sources = new Set<string>(), effective = new Map<string, typeof attributions[number]>(), priorScope = new Set(manifest.executionScope);
    for (const answer of selected) {
      const same = related.get(answer.candidate.input_id)!, reviews = same.filter(task => (task.data as TaskData).reviewOf);
      for (const review of reviews) {
        const seen = new Set<string>(); let current = review;
        while ((current.data as TaskData).reviewOf) {
          if (seen.has(current.id)) throw new Error("归因复核链循环：" + review.id);
          seen.add(current.id);
          const parent = allByTask.get((current.data as TaskData).reviewOf!.taskId);
          if (!parent || (parent.data as TaskData).candidates.A.input_id !== answer.candidate.input_id)
            throw new Error("归因复核链回答身份不一致：" + review.id);
          current = parent;
        }
        if (current.id !== answer.task.id) throw new Error("归因复核未指向本回答原任务：" + review.id);
      }
      const accepted = same.filter(task => state.receipts[task.id] && manifest.states[task.id].status === "succeeded")
        .sort((a, b) => state.receipts[b.id].acceptedAt - state.receipts[a.id].acceptedAt);
      effective.set(answer.task.id, accepted[0] ?? answer.task);
      if (state.receipts[answer.task.id] || !accepted.some(task => (task.data as TaskData).reviewOf)) sources.add(answer.task.id);
      for (const review of reviews) if (state.receipts[review.id] || priorScope.has(review.id) ||
        ["pending", "running"].includes(manifest.states[review.id].status)) sources.add(review.id);
    }
    const superseded = supersededAttributionRewriteIds(state), scope = new Set(sources);
    for (const task of manifest.tasks) if (task.stage === "rewrite" && sources.has(task.dependencies.source) && !superseded.has(task.id)) scope.add(task.id);
    for (const id of scope) {
      const task = allByTask.get(id);
      if (!task) throw new Error("所选回答缺少已规划依赖：" + id);
      Object.values(task.dependencies).forEach(dependency => scope.add(dependency));
    }
    if ([...scope].some(id => !manifest.tasks.some(task => task.id === id))) throw new Error("所选回答缺少已规划依赖");
    const executionScope = manifest.tasks.filter(task => scope.has(task.id)).map(task => task.id);
    const selectedAnswers = selected.map(({ candidate, task, standard }) => ({ batch_id: candidate.batch_id, case_id: candidate.case_id,
      version: candidate.version, input_id: candidate.input_id, task_id: effective.get(task.id)!.id, has_standard_answer: standard,
      source: { file: candidate.source, line: candidate.line } }));
    const summary = { applied: !!options.apply, run_id: manifest.runId, answers_per_model: options.answersPerModel,
      selected_answers: selectedAnswers, pilot_answers: selected.length, added_answers: selected.length - previous.length,
      models: Object.fromEntries(models.map(model => [model, { selected: counts.get(model),
        accepted: selected.filter(answer => answer.candidate.version === model && state.receipts[effective.get(answer.task.id)!.id]).length }])),
      criteria_tasks: manifest.tasks.filter(task => task.stage === "criteria" && scope.has(task.id)).length,
      rewrite_tasks: manifest.tasks.filter(task => task.stage === "rewrite" && scope.has(task.id)).length,
      execution_scope_count: executionScope.length, protected_accepted: Object.keys(state.receipts).length };
    if (options.apply) {
      manifest.executionScope = executionScope;
      manifest.preflight.selected_answers = selectedAnswers;
      manifest.preflight.pilot_answers = selected.length;
      manifest.preflight.strata = [...strata.entries()].map(([key, values]) => ({ key, total: values.length,
        selected: values.filter(answer => ids.has(answer.task.id)).length }));
      await writeRunState(run, state);
    }
    return summary;
  } finally { await release(); }
}
