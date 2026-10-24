import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";

const ajv = new Ajv2020({ strict: false });
ajv.addKeyword({ keyword: "bsonType", validate(type, value) {
  return (Array.isArray(type) ? type : [type]).some(kind => kind === "date" ? value instanceof Date :
    kind === "null" ? value === null : kind === "array" ? Array.isArray(value) :
    kind === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) :
    kind === "bool" ? typeof value === "boolean" : ["int", "long", "double"].includes(kind) ? typeof value === "number" :
    typeof value === kind);
} });

test("Mongo publication JSON Schema separates trees, inputs and comparisons", async () => {
  const validator = JSON.parse(await readFile(new URL("../schemas/workflow/mongo-publication.validator.json", import.meta.url), "utf8"));
  const valid = ajv.compile(validator.$and[0].$jsonSchema);
  const tree = { _id: "attribution_tree:task:2026-10-19:b_post_train_fast:topic-run", kind: "attribution_tree",
    evaluationTaskId: "task", batchId: "2026-10-19", versionId: "b_post_train_fast", runId: "topic-run",
    evaluation_topic: "后训练专题", createdAt: new Date(1),
    result: { attribution_tree: {}, sources: [{ task_id: "attribution", submission_id: "accepted" }], clustering: {} } };
  assert(valid(tree), JSON.stringify(valid.errors));
  const noTopic = { ...tree }; delete noTopic.evaluation_topic;
  assert(!valid(noTopic));
  assert(!valid({ ...tree, kind: "comparison" }));
  assert(!valid({ ...tree, versionA: "a_fast" }));
  const common = { evaluationTaskId: "task", batchId: "date", caseId: "case", createdAt: new Date(1) };
  assert(valid({ ...common, _id: "input:task:date:case:a", kind: "input", versionId: "a", trace: {} }));
  assert(valid({ ...common, _id: "comparison:task:date:case:a:b", kind: "comparison",
    versionA: "a", versionB: "b", result: {}, evaluatedAt: new Date(1) }));
  assert(!valid({ ...common, _id: "input:task:date:case:a", kind: "input", versionId: "a", trace: {}, result: {} }));
});

test("problem collection schema requires topic labels and isolates model branches", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/workflow/mongo-problems.validator.json", import.meta.url), "utf8"));
  const valid = ajv.compile(schema.$jsonSchema), inputId = "00000000-0000-4000-8000-000000000001";
  const records = [
    { _id: "class:topic:class1", kind: "class", id: "class1", model: "b_post_train_fast",
      category: "模型推断与生成/事实关系推导", direction: "计算错误", label: "问题类", definition: "问题定义",
      originalLabel: "原类名", originalDefinition: "原定义" },
    { _id: "sample:topic:" + inputId, kind: "sample", id: inputId, inputId, model: "b_post_train_fast",
      traceId: "original-session", date: "2026-10-19", caseId: "case", taskSummary: "任务摘要",
      source: { runId: "source", taskId: "task", submissionId: "accepted", evaluatorVersion: "judge" },
      replay: null, findings: [{ id: "finding", summary: "问题摘要", text: "原文", reason: "原因", importance: "high",
        evidenceStatus: "established", status: "grouped", pendingStatuses: [], classIds: ["class1"],
        components: ["模型推断与生成/事实关系推导"], evidence: [{ message_index: 1, quote: "本模型证据" }] }] },
  ];
  for (const cutoff of [false, true]) for (const evaluationTaskId of ["topic-first", "topic-second"]) {
    for (const record of records) {
      const doc = { ...record, evaluationTaskId, evaluation_topic: "后训练专题", batchId: "2026-10-19", runId: "topic-run",
        scope: { kind: cutoff ? "accepted-at-cutoff" : "full-evaluation", capturedAt: "2026-10-21T00:00:00Z",
          sourceEvaluationComplete: !cutoff, targetAttributions: 1, acceptedAttributions: 1, excludedAttributions: 0 } };
      assert(valid(doc), JSON.stringify(valid.errors));
      const missing = structuredClone(doc); delete missing.evaluation_topic;
      assert(!valid(missing)); assert(!valid({ ...doc, model: "b_fast" }));
      assert(!valid({ ...doc, evaluationTaskId: "invalid task/id" }));
      assert(!valid({ ...doc, evaluation_topic: "" }));
      assert(!valid({ ...doc, batchId: "not-a-date" }));
      assert(!valid({ ...doc, scope: { ...doc.scope, sourceEvaluationComplete: cutoff } }));
      const unscoped = structuredClone(record);
      if (unscoped.kind === "sample") unscoped.id = "a".repeat(64);
      assert(valid(unscoped), "Unscoped collection records must remain valid: " + JSON.stringify(valid.errors));
    }
  }
});
