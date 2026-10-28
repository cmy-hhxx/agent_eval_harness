import { sessionProblems } from "@eval/agents/attribution";
import path from "node:path";
import { Script } from "node:vm";
import { mkdir, readFile } from "node:fs/promises";
import { atomicWrite, readProblemLibrary, problemLibraryFile } from "@eval/data";
import { emptyLibrary } from "@eval/agents/clustering";
import { clusteringJobRepository, originalResultRow, readClusteringClassText, readRunState, readRunTasks } from "@eval/workflows/comparison";
import { pinnedAttributionEntries, projectProblemLibraryTree, selectedAttributionEntries } from "./attribution-review-tree.mjs";
import { renderAttributionReview } from "./attribution-review-view.mjs";

const args = process.argv.slice(2), options = name => args.flatMap((arg, index) => {
  if (arg !== name) return [];
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} 缺少路径`);
  return [args[index + 1]];
}), option = name => options(name)[0];
const suppliedRun = option("--run");
if (!suppliedRun) throw new Error("用法：node scripts/attribution-review.mjs --run 归因目录 [--clustering 聚类目录] [--model 模型ID] [--library 问题库目录] [--samples 任务摘要JSON] [--out HTML] [--json 归因树JSON]");
const run = path.resolve(suppliedRun), output = path.resolve(option("--out") ?? path.join(run, "review.html"));
const summariesFile = path.resolve(option("--samples") ?? path.join(run, "sample-summaries.json"));
const libraryTarget = { kind: "directory", path: path.resolve(option("--library") ?? "data/problems") };
const clusterRuns = options("--clustering").map(directory => path.resolve(directory));
if (new Set(clusterRuns).size !== clusterRuns.length) throw new Error("聚类作业目录重复");
const selectedModel = option("--model"), jsonOutput = option("--json");
const knownModels = [{ id: "a_fast", label: "A组Fast" }, { id: "a_expert", label: "A组Expert" },
  { id: "b_fast", label: "B组Fast" }, { id: "b_expert", label: "B组Expert" }];
const models = selectedModel ? [knownModels.find(model => model.id === selectedModel) ??
  { id: selectedModel, label: selectedModel === "b_post_train_fast" ? "B post_train_fast" : selectedModel }] : knownModels;
const href = file => {
  const relative = path.relative(path.dirname(output), file).split(path.sep).map(encodeURIComponent).join("/");
  return relative.startsWith(".") ? relative : "./" + relative;
};
const jsonl = text => text.split(/\r?\n/u).filter(line => line.trim()).map(line => ({ line, value: JSON.parse(line) }));
const [summaries, libraries] = await Promise.all([
  readFile(summariesFile, "utf8").then(JSON.parse),
  Promise.all(models.map(async model => await readProblemLibrary(problemLibraryFile(libraryTarget, model.id)) ?? emptyLibrary(model.id))),
]);
let selected, targets, displayConfig;
if (clusterRuns.length) {
  const clusterStates = await Promise.all(clusterRuns.map(directory => clusteringJobRepository.readRun(directory)));
  const sharedLibrary = clusterStates[0].manifest.config.problemLibrary;
  if (clusterStates.some(state => state.manifest.config.problemLibrary.kind !== sharedLibrary.kind ||
    path.resolve(state.manifest.config.problemLibrary.path) !== path.resolve(sharedLibrary.path)))
    throw new Error("聚类作业的问题库不一致");
  const sources = clusterStates.flatMap(state => state.manifest.config.clusteringJob.sources);
  const runs = [...new Set(sources.map(source => source.run))];
  const materials = await Promise.all(runs.map(async directory => {
    const [state, entries] = await Promise.all([readRunTasks(directory, sources.filter(source => source.run === directory).map(source => source.task_id)),
      readFile(path.join(directory, "results", "attribution.jsonl"), "utf8").then(jsonl)]);
    return [directory, state, entries];
  }));
  selected = pinnedAttributionEntries(sources, new Map(materials.map(([directory, state]) => [directory, state])), new Map(materials.map(([directory, _state, entries]) => [directory, entries])));
  targets = sources.map(source => ({ input_id: source.input_id, version: source.model, batch_id: source.batch_id, case_id: source.case_id }));
  displayConfig = clusterStates[0].manifest.config;
} else {
  const [state, entries] = await Promise.all([readRunState(run), readFile(path.join(run, "results", "attribution.jsonl"), "utf8").then(jsonl)]);
  selected = selectedAttributionEntries(state, entries).map(entry => {
    const meta = entry.value.session_meta, resultId = meta.session_id ?? meta.case_id;
    const task = state.manifest.tasks.find(task => task.stage === "attribution-session" && state.receipts[task.id]?.exported?.id === resultId);
    const candidate = task?.data.candidate, receipt = task && state.receipts[task.id];
    if (!task || !candidate || !receipt) throw new Error("冻结回答缺少 canonical attribution-session");
    return { entry, source: { run, run_id: state.manifest.runId, task_id: task.id, submission_id: receipt.submissionId, evaluator_version: receipt.evaluatorVersion,
      input_id: candidate.input_id, model: candidate.version, batch_id: candidate.batch_id, case_id: candidate.case_id, source: { file: candidate.source, line: candidate.line } } };
  });
  targets = state.manifest.preflight.selected_answers; displayConfig = state.manifest.config;
}
if (selectedModel) {
  selected = selected.filter(({ source }) => source.model === selectedModel);
  targets = targets.filter(answer => answer.version === selectedModel);
  if (!targets.length) throw new Error("所选模型没有归因来源：" + selectedModel);
}
const byTask = new Map(selected.map(({ entry, source }) => [source.task_id, entry]));
const titles = new Map();
for (const sample of summaries.samples) {
  const inputId = sample.inputId;
  if (!inputId || titles.has(inputId)) throw new Error("任务摘要输入身份缺失或重复");
  titles.set(inputId, sample.taskSummary);
}
const classTexts = new Map(await Promise.all(libraries.map(async (library, index) => {
  if (library.model !== models[index].id) throw new Error("问题库模型不一致：" + models[index].id);
  return [library.model, await readClusteringClassText(displayConfig, library)];
})));
const rows = selected.map(({ entry, source }, index) => {
  const row = entry.value, meta = row.session_meta, model = models.find(model => model.id === source.model);
  if (!model) throw new Error("归因 JSONL 模型无效：" + source.model);
  const raw = originalResultRow("attribution", row);
  return { id: `sample-${index + 1}`, inputId: source.input_id, taskId: source.task_id,
    date: source.batch_id, caseId: source.case_id, model: source.model, modelName: model.label,
    hasStandard: raw.turns.some(turn => turn.is_correct !== null), raw, taskSummary: titles.get(source.input_id),
    problemSummaries: new Map(sessionProblems(raw).map(problem => [problem.problem_id, problem.label])),
    attribution: { run: source.run, run_id: source.run_id, task_id: source.task_id, submission_id: source.submission_id, evaluator_version: source.evaluator_version },
    sourceRecord: { ...source.source }, deferred: [],
    source: { label: model.label + " JSONL", href: href(path.join(run, "models", model.id + ".jsonl")) },
    resultLink: href(path.join(run, "models", model.id + ".jsonl")) };
});
const acceptedInputs = new Set(rows.map(row => row.inputId));
const unfinished = targets.flatMap((answer, index) => {
  if (acceptedInputs.has(answer.input_id)) return [];
  const model = models.find(model => model.id === answer.version);
  if (!model) throw new Error("未完成样本模型无效：" + answer.version);
  return [{ id: `unfinished-${index + 1}`, inputId: answer.input_id, model: answer.version, modelName: model.label,
    date: answer.batch_id, caseId: answer.case_id, taskSummary: titles.get(answer.input_id), hasStandard: answer.has_standard_answer }];
});
if (new Set(rows.map(row => row.taskId)).size !== rows.length) throw new Error("聚类审阅样本重复");
for (const clusterRun of clusterRuns) {
  const clusterRows = jsonl(await readFile(path.join(clusterRun, "results", "clustering.jsonl"), "utf8"));
  const selected = new Map(rows.map(row => [row.taskId, row]));
  for (const { value } of clusterRows) {
    const items = new Map(value.items.map(item => [item.id, item]));
    for (const assignment of value.result.assignments) {
      const item = items.get(assignment.item_id);
      if (!item) throw new Error("聚类指派缺少来源项：" + assignment.item_id);
      for (const ref of item.refs) {
        const row = selected.get(ref.attribution?.task_id);
        if (!row || row.inputId !== ref.input_id) continue;
        const finding = sessionProblems(row.raw).find(item => item.problem_id === ref.finding_id);
        if (ref.attribution.run !== row.attribution.run || ref.attribution.run_id !== row.attribution.run_id ||
          ref.attribution.submission_id !== row.attribution.submission_id || ref.attribution.evaluator_version !== row.attribution.evaluator_version ||
          !finding || !finding.component.split(" / ").includes(item.component))
          throw new Error("聚类待观察引用与当前归因不一致：" + row.taskId + "/" + ref.finding_id);
        if (assignment.deferred_reason) row.deferred.push({ findingId: ref.finding_id, component: item.component, reason: assignment.deferred_reason });
      }
    }
  }
}
const attributionTree = projectProblemLibraryTree(rows, libraries, classTexts, unfinished);
const [baseCss, problemCss] = await Promise.all([
  readFile(new URL("./attribution-review/base.css", import.meta.url), "utf8"),
  readFile(new URL("./attribution-review/tree.css", import.meta.url), "utf8"),
]);
const html = renderAttributionReview({ attributionTree }, baseCss, problemCss);
new Script(html.match(/<script>([\s\S]*?)<\/script>/u)[1]);
await mkdir(path.join(run, "models"), { recursive: true });
for (const model of models) {
  const lines = rows.filter(row => row.model === model.id).map(row => byTask.get(row.taskId).line);
  await atomicWrite(path.join(run, "models", model.id + ".jsonl"), lines.length ? lines.join("\n") + "\n" : "");
}
await atomicWrite(output, html);
if (jsonOutput) await atomicWrite(path.resolve(jsonOutput), JSON.stringify(attributionTree, null, 2) + "\n");
console.log(JSON.stringify({ output, answers: rows.length, nodes: attributionTree.nodes.length,
  target_answers: attributionTree.totals.targetSamples, unfinished_answers: unfinished.length,
  pending: attributionTree.pending.observations.length, files: models.length }));
