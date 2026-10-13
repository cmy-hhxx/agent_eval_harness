import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnalysisDataSource, AnalysisQuery, AssistantTool, JsonObject } from "@eval/contracts";
import { erisQuestionSelection } from "@eval/prompts";
import schema from "../../../schemas/eris/question-selection.json" with { type: "json" };

type Decision = { index: number; eligible: boolean; reason: string };
type Candidate = JsonObject & { question: string; case: { batchId: string; caseId: string } };
const validate = new Ajv2020({ strict: false }).compile<{ decisions: Decision[] }>(schema);

/** Review only one bounded pool of original questions; never substitute an unreviewed case. */
export async function comparisonSample(data: AnalysisDataSource, query: AnalysisQuery, context: Parameters<AssistantTool["execute"]>[1]) {
  const limit = query.limit ?? 5;
  const pool = await data.list({ ...query, limit: 20, includeAnalysis: true });
  if (pool.kind !== "comparisons" || !Array.isArray(pool.items)) throw new Error("问句筛选缺少有效对战目录。");
  const candidates = pool.items as Candidate[];
  const selection = pool.selection as { availableCaseCount: number; remainingCaseCount: number };
  let decisions: Decision[] = [];
  let qualityCheck: { elapsedMs: number; usage: JsonObject } | undefined;
  if (candidates.length) {
    if (!context.complete) throw new Error("问句质量筛选不可用，尚未返回随机案例。");
    const outputSchema = { ...schema, properties: { decisions: { ...schema.properties.decisions,
      minItems: candidates.length, maxItems: candidates.length } } };
    const check = await context.complete({ systemPrompt: erisQuestionSelection, maxThinking: "low", outputSchema,
      draft: { questions: candidates.map(({ question }, index) => ({ index, question })) } });
    context.signal.throwIfAborted();
    let review: unknown;
    try { review = JSON.parse(check.text); } catch { /* Invalid checks never release unreviewed questions. */ }
    if (!validate(review) || review.decisions.length !== candidates.length ||
      new Set(review.decisions.map(item => item.index)).size !== candidates.length || review.decisions.some(item => item.index >= candidates.length))
      throw new Error("问句质量筛选结果无效，尚未返回随机案例。");
    decisions = review.decisions;
    qualityCheck = { elapsedMs: check.elapsedMs, usage: check.usage };
  }
  const approved = new Map(decisions.filter(item => item.eligible).map(item => [item.index, item.reason]));
  // The source pool is already randomized across distinct questions and the requested scope.
  const qualified = candidates.flatMap((item, index) => approved.has(index) ? [{ ...item, questionSelectionReason: approved.get(index)! }] : []);
  const items = qualified.slice(0, limit);
  return { result: { ...pool, total: items.length, offset: 0, limit, hasMore: false, nextOffset: null, items,
    selection: { ...selection, mode: "quality_random", checkedCaseCount: candidates.length, qualifiedCaseCount: qualified.length,
      remainingCaseCount: selection.remainingCaseCount + qualified.length - items.length,
      unreviewedCaseCount: selection.remainingCaseCount,
      rejectedCases: candidates.filter((_, index) => !approved.has(index)).map(item => item.case) } }, qualityCheck };
}
