import path from "node:path";
import { safeId, type AnalysisDataSource, type AnalysisReference, type AnalysisQuery, type JsonObject } from "@eval/contracts";
import { exists, localFiles, readJson } from "@eval/data";
import { locateAnalysisInput, readAnalysisInput, readRunTasks, type Checkpoint } from "@eval/workflows/comparison";
import { cite, evidenceSources, images } from "@eval/tools";

function page(total: number, offset: number, limit: number, unit: "items" | "messages" | "characters") {
  const end = Math.min(total, offset + limit);
  return { total, offset, limit, unit, hasMore: end < total, nextOffset: end < total ? end : null };
}

export class LocalAnalysisData implements AnalysisDataSource {
  constructor(readonly directory: string) {}
  run(id: string) { return path.join(this.directory, safeId(id)); }
  async list(query: AnalysisQuery) {
    const offset = query.offset ?? 0, limit = Math.min(query.limit ?? 30, 100);
    if (!query.runId) {
      const names = await exists(this.directory) ? await localFiles.list(this.directory) : [];
      const items = [];
      for (const runId of names) {
        const file = path.join(this.run(runId), "state.json");
        if (!(await exists(file))) continue;
        const state = await readJson<Checkpoint>(file);
        if (state.format !== "evaluation-run") continue;
        if (query.query && !runId.includes(query.query)) continue;
        items.push({ runId, evaluatorVersion: state.evaluatorVersion, status: state.status });
      }
      return { kind: "runs", ...page(items.length, offset, limit, "items"), items: items.slice(offset, offset + limit) };
    }
    const saved = await readJson<Checkpoint>(path.join(this.run(query.runId), "state.json"));
    const items = Object.entries(saved.inputs).map(([inputId, input]) => ({ reference: { runId: query.runId!, inputId }, runId: query.runId!, inputId, batchId: input.batch_id, caseId: input.case_id, model: input.version,
      tasks: Object.entries(saved.tasks).filter(([, task]) => Object.values(task.inputIds).includes(inputId)).map(([taskId, task]) => ({ reference: { runId: query.runId!, taskId }, taskId, stage: task.stage, status: task.status })) }));
    const filtered = query.query ? items.filter((item) => JSON.stringify(item).includes(query.query!)) : items;
    return { kind: "inputs", ...page(filtered.length, offset, limit, "items"), items: filtered.slice(offset, offset + limit), evaluatorVersion: saved.evaluatorVersion };
  }
  async raw(reference: AnalysisReference) {
    if (!reference.inputId) throw new Error("inputId is required");
    const locator = await locateAnalysisInput(this.run(reference.runId), reference.inputId);
    return readAnalysisInput(locator);
  }
  async read(reference: AnalysisReference, options?: { offset?: number; limit?: number }): Promise<JsonObject> {
    if (reference.taskId) {
      if (reference.inputId || reference.messageIndex !== undefined) throw new Error("读取目标不明确：原始消息用 runId + inputId（可加 messageIndex），正式结果用 runId + taskId；不要混用。");
      const state = await readRunTasks(this.run(reference.runId), [reference.taskId]);
      const receipt = state.receipts[reference.taskId];
      if (!receipt) throw new Error("该 taskId 没有已接受的正式结果；原始消息仍可使用 read_data({reference:{runId,inputId}}) 读取。本会话独立任务请用 read_specialist(operationId)。");
      return { kind: "accepted-result", reference, result: receipt.exported?.row ?? receipt.evaluation, evaluatorVersion: receipt.evaluatorVersion };
    }
    const raw = await this.raw(reference), offset = options?.offset ?? 0;
    if (reference.messageIndex === undefined) {
      const limit = Math.min(options?.limit ?? 30, 100);
      return { kind: "messages", reference, ...page(raw.messages.length, offset, limit, "messages"), messages: raw.messages.slice(offset, offset + limit).map((m, i) => {
        const text = evidenceSources(m).filter(source => source.kind === "text").map(source => source.text).join("\n");
        return { reference: { ...reference, messageIndex: offset + i }, messageIndex: offset + i, role: m.role, chars: text.length, preview: text.slice(0, 160) };
      }) };
    }
    const limit = Math.min(options?.limit ?? 8000, 16000);
    const message = raw.messages[reference.messageIndex];
    if (!message) throw new Error("Message index out of range");
    const sources = evidenceSources(message).filter((item) => item.kind === "text");
    const full = sources.map((item) => item.text).join("\n");
    let position = 0;
    const evidence = sources.flatMap((source) => {
      const start = Math.max(0, offset - position), end = Math.min(source.text.length, offset + limit - position);
      position += source.text.length + 1;
      return end > start ? [cite(reference.messageIndex!, source, start, end)] : [];
    });
    return { kind: "message", reference, ...page(full.length, offset, limit, "characters"), text: full.slice(offset, offset + limit), evidence };
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
