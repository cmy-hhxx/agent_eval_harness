import test from "node:test";
import assert from "node:assert/strict";
import { createEris } from "@eval/assistant";
import type { AnalysisQuery } from "@eval/contracts";

const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
const context = { scope: { userId: "test", sessionId: "test" }, callId: "sample", signal: new AbortController().signal, progress() {}, complete: unexpected };

test("random case reads preserve scope and deliver questions and assessments without a second model", async () => {
  const queries: AnalysisQuery[] = [];
  const reference = { collectionId: "0_wencai/0_daily_eval", runId: "run", taskId: "comparison" };
  const source = { kind: "comparisons", runId: "run", selectionReason: "running_with_inputs", total: 1,
    items: [{ reference, question: "计算2+2", case: { batchId: "batch", caseId: "one" }, assessments: [{ model: "a", summary: "已回答" }] }],
    selection: { mode: "random", availableCaseCount: 4, remainingCaseCount: 3 } };
  const before = structuredClone(source);
  const tool = createEris({ data: { async list(query) { queries.push(query); return source; }, read: unexpected, search: unexpected, image: unexpected },
    search: { search: unexpected }, web: { read: unexpected } }).tools.find(tool => tool.name === "list_data")!;
  const query: AnalysisQuery = { view: "comparisons", sample: true, limit: 1, comparisonTier: "Fast", outcome: "all",
    excludeCases: [{ batchId: "batch", caseId: "seen" }] };
  const result = await tool.execute(query, context);
  assert.deepEqual(queries, [{ ...query, includeAnalysis: true }]);
  assert.deepEqual(JSON.parse(result.content[0].text!), source);
  assert.equal(result.details, undefined);
  assert.deepEqual(source, before);
  await tool.execute({ ...query, collectionId: reference.collectionId, runId: reference.runId }, context);
  assert.deepEqual(queries[1], { ...query, collectionId: reference.collectionId, runId: reference.runId, includeAnalysis: true });
  source.items = [];
  assert.deepEqual(JSON.parse((await tool.execute(query, context)).content[0].text!).items, []);
});
