import type { AnalysisQuery, AnalysisReadOptions, JsonObject, RunReference } from "@eval/contracts";
import { answerReviewAnswer, answerReviewTaskInput, readAnswerReviewAnalysis, readAnswerReviewInput, readAnswerReviewSources } from "@eval/workflows/answer-review";
import { LocalAnalysisData } from "./assistant-data.js";

function page(total: number, offset: number, limit: number) { const end = Math.min(total, offset + limit); return { total, offset, limit, unit: "items", hasMore: end < total, nextOffset: end < total ? end : null }; }
export class AnswerReviewAnalysisData {
  private messages: LocalAnalysisData;
  constructor(directory: string) {
    const raw = async (reference: RunReference) => {
      if (!reference.inputId) throw new Error("inputId is required");
      return (await readAnswerReviewInput(this.run(reference.runId), reference.inputId)).raw;
    };
    this.messages = new class extends LocalAnalysisData { override raw = raw; }(directory);
  }
  run(id: string) { return this.messages.run(id); }
  search(...args: Parameters<LocalAnalysisData["search"]>) { return this.messages.search(...args); }
  image(...args: Parameters<LocalAnalysisData["image"]>) { return this.messages.image(...args); }
  async raw(reference: RunReference) {
    if (!reference.inputId) throw new Error("inputId is required");
    return (await readAnswerReviewInput(this.run(reference.runId), reference.inputId)).raw;
  }
  async list(query: AnalysisQuery): Promise<JsonObject> {
    if (!query.runId) throw new Error("请选择运行");
    if (query.view === "comparisons") throw new Error("该运行是独立回答评测，没有两两胜负；请读取 inputs");
    const { state, candidates, summary, rows } = await readAnswerReviewAnalysis(this.run(query.runId));
    const progress = new Map(rows.map(row => [row.inputId,row]));
    const items = candidates.filter(candidate => !query.query || JSON.stringify([candidate.question, candidate.version, candidate.batch_id, candidate.case_id]).includes(query.query)).map(candidate => ({
      reference: { runId: query.runId, inputId: candidate.input_id }, inputId: candidate.input_id,
      model: candidate.version, modelName: candidate.name, question: candidate.question, batchId: candidate.batch_id, caseId: candidate.case_id,
      tasks: Object.entries({...progress.get(candidate.input_id)!.stages,'instruction-review':progress.get(candidate.input_id)!.instructionReview})
        .filter(([,view])=>view.taskId).map(([stage,view])=>({reference:{runId:query.runId,taskId:view.taskId!},stage,status:view.status})),
    }));
    const offset = query.offset ?? 0, limit = Math.min(query.limit ?? 30, 100);
    return { kind: "inputs", workflow: "answer-review", runId: query.runId, evaluatorVersion: state.manifest.evaluatorVersion,
      summary, ...page(items.length, offset, limit), items: items.slice(offset, offset + limit) };
  }
  async read(reference: RunReference & { query?: string; comparisonTier?: string; sourceId?: string }, options?: AnalysisReadOptions): Promise<JsonObject> {
    const run = this.run(reference.runId);
    if (reference.query !== undefined) {
      const { candidates } = await readAnswerReviewAnalysis(run);
      const matches = candidates.filter(candidate => candidate.question.includes(reference.query!));
      if (!reference.query.trim() || matches.length !== 1) throw new Error(`案例匹配数为 ${matches.length}，请用 list_data 返回的精确引用`);
      return this.read({ runId: reference.runId, inputId: matches[0].input_id }, options);
    }
    if (reference.sourceId) {
      if (!reference.taskId || reference.inputId || reference.messageIndex !== undefined) throw new Error("证据来源使用 taskId + sourceId");
      const { sources } = await readAnswerReviewSources(run, reference.taskId), text = sources[reference.sourceId];
      if (text === undefined) throw new Error("任务证据来源不存在");
      const chars = Array.from(text), offset = options && "offset" in options ? options.offset ?? 0 : 0;
      const limit = options && "limit" in options ? Math.min(options.limit ?? 8000, 16000) : 8000;
      const end = Math.min(chars.length, offset + limit);
      return { kind: "message", reference, text: chars.slice(offset, end).join(""), total: chars.length, offset, limit,
        unit: "unicode_code_points", hasMore: end < chars.length, nextOffset: end < chars.length ? end : null };
    }
    if (options?.view === "case") {
      let inputId = reference.inputId;
      let formal: JsonObject | undefined;
      if (reference.taskId) {
        const { state } = await readAnswerReviewAnalysis(run);
        const task = state.manifest.tasks.find(task => task.id === reference.taskId);
        inputId = task && answerReviewTaskInput(task);
        formal = await this.read(reference);
      }
      if (!inputId) throw new Error("案例输入未登记");
      const { raw, candidate } = await readAnswerReviewInput(run, inputId);
      const { question, ...answer } = answerReviewAnswer(raw, candidate, { runId: reference.runId, inputId }, options.audience);
      return { kind: "case", workflow: "answer-review", reference, question, case: { batchId: candidate.batch_id, caseId: candidate.case_id }, answers: [answer], ...(formal ? { formal } : {}) };
    }
    if (reference.taskId) {
      if (reference.inputId || reference.messageIndex !== undefined) throw new Error("正式结果使用 taskId");
      const { sources, receipt } = await readAnswerReviewSources(run, reference.taskId);
      return { kind: "accepted-result", workflow: "answer-review", reference, evaluatorVersion: receipt.evaluatorVersion,
        result: receipt.exported?.row ?? receipt.evaluation,
        evidenceSources: Object.entries(sources).map(([sourceId, text]) => ({ reference: { ...reference, sourceId }, length: Array.from(text).length, unit: "unicode_code_points" })) };
    }
    return this.messages.read(reference, options);
  }
}
