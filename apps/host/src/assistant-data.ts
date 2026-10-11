import path from "node:path";
import { safeId, type AnalysisDataSource, type AnalysisReference, type AnalysisQuery, type AnalysisReadOptions, type JsonObject } from "@eval/contracts";
import { exists, localFiles, readJson } from "@eval/data";
import { analysisComparisonScope, analysisProgress, analysisTaskPurpose, assertComparableGroups, locateAnalysisInput, readAnalysisAnswer, readAnalysisComparisonStats, readAnalysisInput, readRunTasks, type Checkpoint, type EvalConfig } from "@eval/workflows/comparison";
import { cite, evidenceSources, images } from "@eval/tools";

function page(total: number, offset: number, limit: number, unit: "items" | "messages" | "characters") {
  const end = Math.min(total, offset + limit);
  return { total, offset, limit, unit, hasMore: end < total, nextOffset: end < total ? end : null };
}

function messagePage(raw: Awaited<ReturnType<typeof readAnalysisInput>>, reference: AnalysisReference, options?: { offset?: number; limit?: number }) {
  const offset = options?.offset ?? 0, limit = Math.min(options?.limit ?? 8000, 16000);
  const message = raw.messages[reference.messageIndex!];
  if (!message) throw new Error("Message index out of range");
  const sources = evidenceSources(message).filter((item) => item.kind === "text");
  const full = sources.map((item) => item.text).join("\n");
  let position = 0;
  const evidence = sources.flatMap((source) => {
    const start = Math.max(0, offset - position), end = Math.min(source.text.length, offset + limit - position);
    position += source.text.length + 1;
    return end > start ? [cite(reference.inputId!, reference.messageIndex!, source, start, end)] : [];
  });
  return { kind: "message", reference, ...page(full.length, offset, limit, "characters"), text: full.slice(offset, offset + limit), evidence };
}

export class LocalAnalysisData implements AnalysisDataSource {
  constructor(readonly directory: string) {}
  run(id: string) { return path.join(this.directory, safeId(id)); }
  async list(query: AnalysisQuery) {
    const comparisonView = query.view === "comparisons";
    if (query.view && !query.runId) throw new Error("view 需要 runId；先用 list_data({}) 获取 currentRun.runId。");
    const offset = query.offset ?? 0, limit = Math.min(query.limit ?? (comparisonView ? 5 : 30), comparisonView ? 20 : 100);
    if (!query.runId) {
      const names = await exists(this.directory) ? await localFiles.list(this.directory) : [];
      const items = [];
      const runCounts = { scope: "all_registered_runs" as const, total: 0, states: { running: 0, finished: 0, interrupted: 0 } };
      let selected: { runId: string; evaluatorVersion: string; status: Checkpoint["status"]; summary: ReturnType<typeof analysisProgress> } | undefined;
      for (const runId of names) {
        const file = path.join(this.run(runId), "state.json");
        if (!(await exists(file))) continue;
        const state = await readJson<Checkpoint>(file);
        if (state.format !== "evaluation-run") continue;
        const summary = analysisProgress(state);
        runCounts.total++;
        runCounts.states[state.status]++;
        const item = { runId, evaluatorVersion: state.evaluatorVersion, status: state.status, startedAt: summary.startedAt,
          ...(summary.finishedAt !== undefined ? { finishedAt: summary.finishedAt } : {}), inputCount: summary.inputCount, caseCount: summary.caseCount };
        items.push(item);
        const preferred = summary.inputCount > 0 && (!selected ||
          (state.status === "running" && selected.status !== "running") ||
          ((state.status === "running") === (selected.status === "running") && summary.startedAt > selected.summary.startedAt));
        if (preferred) selected = { runId, evaluatorVersion: state.evaluatorVersion, status: state.status, summary };
      }
      items.sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId));
      const currentRun = selected ? { ...selected, summary: { ...selected.summary,
        formalComparisonStats: await readAnalysisComparisonStats(this.run(selected.runId), selected.summary.formalComparisonReferences.map((reference) => reference.taskId)) },
        selectionReason: selected.status === "running" ? "running_with_inputs" as const : "latest_with_inputs" as const } : null;
      const filtered = query.query ? items.filter((item) => item.runId.includes(query.query!)) : items;
      return { kind: "runs" as const, ...page(filtered.length, offset, limit, "items"), items: filtered.slice(offset, offset + limit), currentRun, runCounts };
    }
    const saved = await readJson<Checkpoint>(path.join(this.run(query.runId), "state.json"));
    const config = saved.config as EvalConfig;
    assertComparableGroups(config);
    const versions = new Map(config.inputs.versions.map((version) => [version.id, version]));
    const model = (id: string) => {
      const version = versions.get(id);
      if (!version) throw new Error("输入版本未登记：" + id);
      return { model: id, modelName: version.display_name ?? version.name, comparisonTier: version.comparison_tier ?? null };
    };
    const comparisonGroups = config.comparisons.map((group) => {
      const models = group.map(model);
      return { comparisonTier: models[0]!.comparisonTier, models: models.map(({ model, modelName }) => ({ model, modelName })) };
    });
    const summary = analysisProgress(saved);
    const formalComparisonStats = await readAnalysisComparisonStats(this.run(query.runId), summary.formalComparisonReferences.map((reference) => reference.taskId));
    if (comparisonView) {
      const filtered = query.query ? formalComparisonStats.records.filter(record => JSON.stringify(record).includes(query.query!)) : formalComparisonStats.records;
      const items = filtered.slice(offset, offset + limit).map(({ reference, question, scope }) => ({
        reference, questionPreview: question.slice(0, 300), questionChars: question.length,
        comparisonTier: scope.comparisonTier, case: scope.case,
        inputs: Object.values(saved.tasks[reference.taskId]!.inputIds).map(inputId => ({
          ...model(saved.inputs[inputId]!.version), reference: { runId: query.runId!, inputId },
        })),
        outcomes: scope.comparisons.map(({ result, resultLabel, winnerModel }) => ({ result, resultLabel, winnerModel })),
      }));
      return { kind: "comparisons" as const, ...page(filtered.length, offset, limit, "items"), items,
        evaluatorVersion: saved.evaluatorVersion, summaryScope: "run" as const, summary: { ...summary, formalComparisonStats } };
    }
    const items = Object.entries(saved.inputs).map(([inputId, input]) => ({ reference: { runId: query.runId!, inputId }, runId: query.runId!, inputId, batchId: input.batch_id, caseId: input.case_id, ...model(input.version),
      tasks: Object.entries(saved.tasks).filter(([, task]) => Object.values(task.inputIds).includes(inputId)).map(([taskId, task]) => ({ reference: { runId: query.runId!, taskId }, taskId, stage: task.stage, purpose: analysisTaskPurpose(task), status: task.status })) }));
    const filtered = query.query ? items.filter((item) => JSON.stringify(item).includes(query.query!)) : items;
    return { kind: "inputs" as const, ...page(filtered.length, offset, limit, "items"), items: filtered.slice(offset, offset + limit), comparisonGroups, evaluatorVersion: saved.evaluatorVersion,
      summaryScope: "run" as const, summary: { ...summary, formalComparisonStats } };
  }
  async raw(reference: AnalysisReference) {
    if (!reference.inputId) throw new Error("inputId is required");
    const locator = await locateAnalysisInput(this.run(reference.runId), reference.inputId);
    return readAnalysisInput(locator);
  }
  async read(reference: AnalysisReference, options?: AnalysisReadOptions): Promise<JsonObject> {
    if (options?.view === "case") return this.case(reference, options.audience);
    if (options?.view === "evidence") {
      if (!reference.inputId || reference.taskId || reference.messageIndex !== undefined) throw new Error("批量证据使用 runId + inputId，节点与分页放在 messages 中。");
      const raw = await this.raw(reference);
      const items = options.messages.map(({ messageIndex, ...slice }) => {
        const node = { ...reference, messageIndex };
        if (!raw.messages[messageIndex]) return { kind: "message-error", reference: node, error: "Message index out of range" };
        return messagePage(raw, node, slice);
      });
      return { kind: "evidence", reference, requestedCount: items.length, readCount: items.filter(item => item.kind === "message").length, items };
    }
    if (reference.taskId) {
      if (reference.inputId || reference.messageIndex !== undefined) throw new Error("读取目标不明确：原始消息用 runId + inputId（可加 messageIndex），正式结果用 runId + taskId；不要混用。");
      const state = await readRunTasks(this.run(reference.runId), [reference.taskId]);
      const receipt = state.receipts[reference.taskId];
      if (!receipt) throw new Error("该 taskId 没有已接受的正式结果；原始消息仍可使用 read_data({reference:{runId,inputId}}) 读取。本会话独立任务请用 read_specialist(operationId)。");
      const result = receipt.exported?.row ?? receipt.evaluation;
      const comparisonScope = receipt.exported ? analysisComparisonScope(receipt.exported.row, state.manifest.config as EvalConfig) : null;
      return { kind: "accepted-result", reference, ...(comparisonScope ? { comparisonScope } : {}), result, evaluatorVersion: receipt.evaluatorVersion };
    }
    const raw = await this.raw(reference), offset = options?.offset ?? 0;
    if (reference.messageIndex === undefined) {
      const limit = Math.min(options?.limit ?? 30, 100);
      return { kind: "messages", reference, ...page(raw.messages.length, offset, limit, "messages"), messages: raw.messages.slice(offset, offset + limit).map((m, i) => {
        const text = evidenceSources(m).filter(source => source.kind === "text").map(source => source.text).join("\n");
        return { reference: { ...reference, messageIndex: offset + i }, messageIndex: offset + i, role: m.role, chars: text.length, preview: text.slice(0, 160) };
      }) };
    }
    return messagePage(raw, reference, options);
  }
  private async case(reference: AnalysisReference, audience?: "user"): Promise<JsonObject> {
    if (reference.messageIndex !== undefined || Boolean(reference.inputId) === Boolean(reference.taskId))
      throw new Error("案例使用 runId + taskId 或 runId + inputId，不接受消息坐标。");
    const run = this.run(reference.runId);
    const saved = await readJson<Checkpoint>(path.join(run, "state.json"));
    const formal = reference.taskId ? await this.read(reference) : undefined;
    if (formal && !formal.comparisonScope) throw new Error("该 taskId 不是已裁决的正式比较；单条回答请使用 inputId。");
    const ids = reference.inputId ? [reference.inputId] : Object.values(saved.tasks[reference.taskId!]!.inputIds);
    const answers = await Promise.all(ids.map(inputId => readAnalysisAnswer(run, inputId, reference.runId, audience)));
    const question = answers[0]?.question;
    if (question === undefined || answers.some(answer => answer.question !== question)) throw new Error("案例的原始问题缺失或不一致。");
    return { kind: "case", reference, question, answers: answers.map(({ question: _question, ...answer }) => answer), ...(formal ? { formal } : {}) };
  }
  async search(reference: AnalysisReference, query: string, options?: { offset?: number; limit?: number }): Promise<JsonObject> {
    if (!query) throw new Error("Search query required");
    const raw = await this.raw(reference), matches = raw.messages.flatMap((message, messageIndex) => {
      const text = evidenceSources(message).filter((s) => s.kind === "text").map((s) => s.text).join("\n");
      const found = text.indexOf(query);
      return found < 0 ? [] : [{ reference: { ...reference, messageIndex }, offset: found, text: text.slice(Math.max(0, found - 100), found + 500) }];
    });
    const offset = options?.offset ?? 0, limit = Math.min(options?.limit ?? 20, 100);
    return { kind: "matches", ...page(matches.length, offset, limit, "messages"), matches: matches.slice(offset, offset + limit) };
  }
  async image(reference: AnalysisReference) {
    if (reference.messageIndex === undefined) throw new Error("messageIndex is required");
    const raw = await this.raw(reference), message = raw.messages[reference.messageIndex];
    if (!message) throw new Error("Message index out of range");
    const content = images(message);
    if (!content.length) throw new Error("消息中没有图片");
    return { content, details: { reference } };
  }
}
