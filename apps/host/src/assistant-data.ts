import path from "node:path";
import { safeId, type AnalysisDataSource, type AnalysisReference, type AnalysisCaseLookup, type AnalysisQuery, type AnalysisReadOptions, type JsonObject } from "@eval/contracts";
import { exists, localFiles, readJson } from "@eval/data";
import { analysisComparisonScope, analysisProgress, analysisTaskPurpose, assertComparableGroups, locateAnalysisInput, readAnalysisAnswer, readAnalysisComparisonStats, readAnalysisInput, readRunTasks, type Checkpoint, type EvalConfig } from "@eval/workflows/comparison";
import { cite, evidenceSources, images } from "@eval/tools";

function page(total: number, offset: number, limit: number, unit: "items" | "messages" | "characters") {
  const end = Math.min(total, offset + limit);
  return { total, offset, limit, unit, hasMore: end < total, nextOffset: end < total ? end : null };
}

function messageMaterial(message: Awaited<ReturnType<typeof readAnalysisInput>>["messages"][number], format: "text" | "json" = "text") {
  if (!message) throw new Error("Message index out of range");
  const sources = evidenceSources(message).filter((item) => item.kind === format);
  return { sources, full: sources.map((item) => item.text).join("\n"), format };
}

function messagePage({ sources, full, format }: ReturnType<typeof messageMaterial>, reference: AnalysisReference, options?: { offset?: number; limit?: number }) {
  const offset = options?.offset ?? 0, limit = Math.min(options?.limit ?? 8000, 16000);
  let position = 0;
  const evidence = sources.flatMap((source) => {
    const start = Math.max(0, offset - position), end = Math.min(source.text.length, offset + limit - position);
    position += source.text.length + 1;
    return end > start ? [cite(reference.inputId!, reference.messageIndex!, source, start, end)] : [];
  });
  return { kind: "message", reference, format, ...page(full.length, offset, limit, "characters"), text: full.slice(offset, offset + limit), evidence };
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
    const tasksByInput = new Map<string, { reference: AnalysisReference; taskId: string; stage: string; purpose: string; status: string }[]>();
    for (const [taskId, task] of Object.entries(saved.tasks)) {
      const entry = { reference: { runId: query.runId!, taskId }, taskId, stage: task.stage, purpose: analysisTaskPurpose(task), status: task.status };
      for (const inputId of new Set(Object.values(task.inputIds))) {
        const tasks = tasksByInput.get(inputId) ?? [];
        tasks.push(entry); tasksByInput.set(inputId, tasks);
      }
    }
    const items = Object.entries(saved.inputs).map(([inputId, input]) => ({ reference: { runId: query.runId!, inputId }, runId: query.runId!, inputId, batchId: input.batch_id, caseId: input.case_id, ...model(input.version),
      tasks: tasksByInput.get(inputId) ?? [] }));
    const filtered = query.query ? items.filter((item) => JSON.stringify(item).includes(query.query!)) : items;
    return { kind: "inputs" as const, ...page(filtered.length, offset, limit, "items"), items: filtered.slice(offset, offset + limit), comparisonGroups, evaluatorVersion: saved.evaluatorVersion,
      summaryScope: "run" as const, summary: { ...summary, formalComparisonStats } };
  }
  async raw(reference: AnalysisReference) {
    if (!reference.inputId) throw new Error("inputId is required");
    const locator = await locateAnalysisInput(this.run(reference.runId), reference.inputId);
    return readAnalysisInput(locator);
  }
  async read(reference: AnalysisReference | AnalysisCaseLookup, options?: AnalysisReadOptions): Promise<JsonObject> {
    if ("query" in reference) {
      const saved = await readJson<Checkpoint>(path.join(this.run(reference.runId), "state.json"));
      const summary = analysisProgress(saved);
      const stats = await readAnalysisComparisonStats(this.run(reference.runId), summary.formalComparisonReferences.map(item => item.taskId));
      const query = reference.query.trim();
      if (!query) throw new Error("案例关键词不能为空。");
      const matches = stats.records.filter(record => record.question.includes(query) && record.scope.comparisonTier === reference.comparisonTier);
      if (matches.length !== 1) throw new Error(matches.length
        ? `匹配到 ${matches.length} 场，请增加题目关键词或用 list_data 定位具体批次：${JSON.stringify(matches.slice(0, 5).map(item => ({ question: item.question, case: item.scope.case })))}`
        : "没有匹配的已裁决对战；缩短原问关键词或检查档位，不猜 ID。用 list_data 核对登记范围。");
      return this.read(matches[0]!.reference, options);
    }
    if (options?.view === "case") return this.case(reference, options.audience);
    if (options?.view === "evidence") {
      if (!reference.inputId || reference.taskId || reference.messageIndex !== undefined) throw new Error("批量证据使用 runId + inputId，节点与分页放在 messages 中。");
      const raw = await this.raw(reference);
      const material = new Map<string, ReturnType<typeof messageMaterial>>();
      const items = options.messages.map(({ messageIndex, format = "text", ...slice }) => {
        const node = { ...reference, messageIndex };
        if (!raw.messages[messageIndex]) return { kind: "message-error", reference: node, error: "Message index out of range" };
        const key = `${messageIndex}:${format}`;
        if (!material.has(key)) material.set(key, messageMaterial(raw.messages[messageIndex], format));
        return messagePage(material.get(key)!, node, { ...slice, limit: slice.limit ?? 16000 });
      });
      return { kind: "evidence", reference, requestedCount: items.length, readCount: items.filter(item => item.kind === "message").length, items };
    }
    if (reference.taskId) {
      if (reference.inputId || reference.messageIndex !== undefined) throw new Error("读取目标不明确：原始消息用 runId + inputId（可加 messageIndex），正式结果用 runId + taskId；不要混用。");
      const state = await readRunTasks(this.run(reference.runId), [reference.taskId]);
      if (!state.manifest.tasks.some(task => task.id === reference.taskId)) {
        throw new Error('taskId 未登记；这不是结果尚未完成。请用 read_case({reference:{runId,query:原问关键词,comparisonTier:档位}}) 按题目定位，不猜改 ID；范围未知时用 list_data。');
      }
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
    return messagePage(messageMaterial(raw.messages[reference.messageIndex]), reference, options);
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
  async search(reference: AnalysisReference, query: string | string[], options?: { offset?: number; limit?: number; scope?: "evidence" | "all" }): Promise<JsonObject> {
    const queries = typeof query === "string" ? [query] : query;
    if (!queries.length || queries.some(query => !query.trim())) throw new Error("Search query required");
    const totals = new Map(queries.map(query => [query, 0]));
    const scope = options?.scope ?? "evidence";
    const raw = await this.raw(reference), matches = raw.messages.flatMap((message, messageIndex) => {
      if (scope === "evidence" && message.role !== "tool" && !["tool_result", "function_call_output"].includes(String(message.type))) return [];
      const sources = evidenceSources(message);
      const plain = sources.filter((s) => s.kind === "text").map((s) => s.text).join("\n");
      let cursor = 0;
      const leaves = sources.filter(source => source.kind === "text").map(source => {
        const leaf = { ...source, start: cursor, end: cursor + source.text.length };
        cursor = leaf.end + 1;
        return leaf;
      });
      // Retrieved documents carry their own title and body. A query repeated in
      // every result is navigation metadata, not evidence about that document.
      const documents = leaves.filter(leaf => leaf.path.endsWith("/title")).flatMap(title => {
        const path = title.path.slice(0, -6), parts = leaves.filter(leaf => leaf.path.slice(0, leaf.path.lastIndexOf("/")) === path);
        return parts.some(leaf => /\/(summary|content|text|body|snippet)$/.test(leaf.path) && leaf.text)
          ? [{ source: { path, title: title.text }, parts: parts.filter(leaf => !leaf.path.endsWith("/query")) }] : [];
      });
      const other = leaves.filter(leaf => scope === "all" && leaf.path.endsWith("/query")
        || !leaf.path.endsWith("/query") && !documents.some(document => leaf.path.startsWith(document.source.path + "/")));
      const regions = documents.length ? [...documents, ...(other.length ? [{ source: undefined, parts: other }] : [])]
        : [{ source: undefined, parts: leaves }];
      return queries.flatMap(query => {
        const terms = [...new Set(query.trim().split(/\s+/u))];
        return regions.flatMap(region => {
          let text = plain, format = "text", positions = terms.map(term => {
            const leaf = region.parts.find(leaf => leaf.text.includes(term));
            return leaf ? leaf.start + leaf.text.indexOf(term) : -1;
          });
          if (positions.some(position => position < 0)) {
            if (documents.length) return [];
            text = sources.find(s => s.kind === "json")!.text; format = "json";
            positions = terms.map(term => text.indexOf(term));
          }
          if (positions.some(position => position < 0)) return [];
          const bodyTerm = region.source ? positions.find(position => region.parts.some(leaf =>
            /\/(summary|content|text|body|snippet)$/.test(leaf.path) && leaf.start <= position && position < leaf.end)) : undefined;
          const found = bodyTerm ?? positions[0];
          const startBound = region.source ? Math.min(...region.parts.map(leaf => leaf.start)) : 0;
          const endBound = region.source ? Math.max(...region.parts.map(leaf => leaf.end)) : text.length;
          totals.set(query, totals.get(query)! + 1);
          const windows: { start: number; end: number }[] = [];
          // An entity may occur only in a trailing title. Include its document,
          // not just the title or the next article, when that record is short.
          if (region.source && endBound - startBound <= 4000) windows.push({ start: startBound, end: endBound });
          for (const position of [...new Set(positions)].sort((a, b) => a - b)) {
            const start = Math.max(startBound, position - 100), end = Math.min(endBound, position + 500), previous = windows.at(-1);
            if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
            else windows.push({ start, end });
          }
          const primary = windows.find(window => window.start <= found && found < window.end)!;
          const readOffset = primary.start;
          return [{ reference: { ...reference, messageIndex }, query, type: message.type ?? "message", ...(typeof message.role === "string" ? { role: message.role } : {}), ...(message.name ? { name: message.name } : {}),
            ...(region.source ? { source: { ...region.source,
              read: { messageIndex, format: "text", offset: startBound, limit: Math.min(16000, endBound - startBound) },
              endOffset: endBound } } : {}),
            format, offset: found, readOffset, text: text.slice(readOffset, primary.end),
            ...(windows.length > 1 ? { contexts: windows.filter(window => window !== primary).map(window => ({ readOffset: window.start, text: text.slice(window.start, window.end) })) } : {}),
            ...(terms.length > 1 ? { terms, termLocations: terms.map((term, index) => ({ term, offset: positions[index], readOffset: Math.max(0, positions[index] - 100) })) } : {}) }];
        });
      });
    });
    const priority = (hit: { role?: string; type: unknown }) => hit.role === "system" || hit.role === "developer" ? 3
      : hit.role === "tool" || ["tool_result", "function_call_output"].includes(String(hit.type)) ? 0
      : hit.type === "llm_turn" ? 2 : 1;
    const titleMatch = (hit: { source?: { title: string }; query: string }) => Number(Boolean(hit.source && hit.query.trim().split(/\s+/u).some(term => hit.source!.title.includes(term))));
    matches.sort((a, b) => priority(a) - priority(b) || titleMatch(b) - titleMatch(a));
    // Many entity queries can identify the same article. Keep its original text
    // once, with every query and term location, before applying pagination.
    const unique = new Map<string, Omit<typeof matches[number], "query"> & { matchedQueries: string[] }>();
    for (const { query, ...hit } of matches) {
      const key = JSON.stringify([hit.reference.messageIndex, hit.format, hit.source?.path,
        hit.readOffset, hit.text.length, hit.contexts?.map(window => [window.readOffset, window.text.length])]);
      const locations = hit.termLocations ?? [{ term: query, offset: hit.offset, readOffset: hit.readOffset }];
      const previous = unique.get(key);
      if (!previous) unique.set(key, { ...hit, matchedQueries: [query], terms: locations.map(location => location.term), termLocations: locations });
      else {
        previous.matchedQueries.push(query);
        for (const location of locations) if (!previous.termLocations!.some(item => item.term === location.term && item.offset === location.offset))
          previous.termLocations!.push(location);
        previous.terms = [...new Set(previous.termLocations!.map(location => location.term))];
      }
    }
    const items = [...unique.values()];
    const offset = options?.offset ?? 0, limit = Math.min(options?.limit ?? 20, 100);
    return { kind: "matches", scope, ...page(items.length, offset, limit, "items"), queries: queries.map(query => ({ query, total: totals.get(query)! })), matches: items.slice(offset, offset + limit) };
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
