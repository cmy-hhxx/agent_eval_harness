import test from "node:test";
import assert from "node:assert/strict";
import {
  applyClustering,
  emptyLibrary,
  projectLibrary,
  resolveActiveClass,
  type ApplyClusteringInput,
  type ClusteringObservation,
} from "./library.js";
import { ValidationError } from "@eval/contracts";
import type { ClusteringResult } from "./types.js";

const observation = (id: string, component: string, label: string, inputId: string): ClusteringObservation => ({
  id,
  component,
  label,
  definition: `${label}。`,
  count: 1,
  established_count: 1,
  uncertain_count: 0,
  established_answer_ids: [inputId],
  examples: [
    {
      finding: label,
      reason: "r",
      dimension: "correctness",
      importance: "high",
      stage: "final_answer",
      evidence_status: "established",
    },
  ],
  refs: [
    {
      input_id: inputId,
      case_id: `case-${inputId}`,
      source: { file: "f.jsonl", line: 7 },
      finding_id: `f-${id}`,
      evidence_status: "established",
      message_index: 3,
      quote: "q",
    },
  ],
});

const receipt = (
  observations: ClusteringObservation[],
  result: ClusteringResult,
): ApplyClusteringInput => ({
  run_id: "run",
  evaluator_version: "r1",
  task_id: "task",
  submission_id: "submission",
  version: "a_fast",
  batch_id: "b1",
  observations,
  result,
  at: "2026-01-01T00:00:00.000Z",
});

const topicLibrary = () => applyClustering(emptyLibrary("model"), receipt([], { assignments: [], merges: [], new_classes: [
  { key: "n1", component: "模型自身推理", label: "现象一", definition: "原定义。", closest_existing: null, novelty: "首例", category_paths: [["有效主题"]] },
  { key: "n2", component: "模型自身推理", label: "现象二", definition: "近义定义。", closest_existing: null, novelty: "首例", category_paths: [["其他主题"]] },
] }));

test("clustering creates components and classes and keeps occurrence lineage", () => {
  let library = emptyLibrary("a_fast");
  const observations = [observation("o1", "色值工具", "色值错误", "in-1")];
  observations[0]!.refs[0]!.evidence_status = "uncertain";
  observations[0]!.examples[0]!.evidence_status = "uncertain";
  observations[0]!.established_count = 0;
  observations[0]!.uncertain_count = 1;
  observations[0]!.established_answer_ids = [];
  library = applyClustering(
    library,
    receipt(observations, {
      assignments: [{ item_id: "o1", new_class_key: "n1" }],
      new_classes: [
        {
          key: "n1",
          component: "色值工具",
          label: "色值错误",
          definition: "颜色值与要求不符。",
          closest_existing: null,
          novelty: "首个问题。", category_paths: [["数值可靠性"]],
        },
      ],
      merges: [],
    }),
  );
  const component = Object.values(library.components)[0]!;
  const problem = Object.values(library.classes)[0]!;
  assert.equal(component.label, "色值工具");
  assert.equal(problem.component_id, component.id);
  assert.equal(component.first_seen?.case_id, "case-in-1");
  assert.equal(component.first_seen?.evaluator_version, "r1");
  assert.equal(problem.first_seen?.evaluator_version, "r1");
  assert.equal(library.occurrences.length, 1);
  assert.equal(library.occurrences[0]!.class_id, problem.id);
  assert.equal(library.occurrences[0]!.input_id, "in-1");
  assert.equal(library.occurrences[0]!.evaluator_version, "r1");
  assert.equal(library.occurrences[0]!.source.line, 7);
  assert.equal(Object.hasOwn(library.occurrences[0]!, "quote"), false, "bank occurrences retain coordinates without copying evidence text");
  assert.equal(library.occurrences[0]!.classification, "created");
  assert.equal(library.occurrences[0]!.evidence_status, "uncertain");

  library = applyClustering(
    library,
    receipt(observations, {
      assignments: [{ item_id: "o1", class_id: problem.id }],
      new_classes: [],
      merges: [],
    }),
  );
  assert.equal(library.occurrences.length, 1, "idempotent by class + input + finding");
  assert.equal(projectLibrary(library).components[0]!.classes[0]!.occurrences, 1);
  const replayed = applyClustering(library, {
    ...receipt(observations, { assignments: [{ item_id: "o1", new_class_key: "n1" }], new_classes: [{
      key: "n1", component: "色值工具", label: "色值错误", definition: "颜色值与要求不符。", closest_existing: null, novelty: "首个问题。", category_paths: [["数值可靠性"]],
    }], merges: [] }),
    at: "2026-01-02T00:00:00.000Z",
  });
  assert.deepEqual(replayed, library, "replaying a receipt must not change its update time");
});

test("merges move occurrences, keep aliases and stay idempotent", () => {
  let library = emptyLibrary("a_fast");
  library = applyClustering(
    library,
    receipt([observation("o1", "模型自身推理", "算术错误", "in-1")], {
      assignments: [{ item_id: "o1", new_class_key: "n1" }],
      new_classes: [
        {
          key: "n1",
          component: "模型自身推理",
          label: "算术错误",
          definition: "数值计算错误。",
          closest_existing: null,
          novelty: "首个问题。", category_paths: [["数值可靠性"]],
        },
      ],
      merges: [],
    }),
  );
  library = applyClustering(
    library,
    receipt([observation("o2", "模型自身推理", "计算错误", "in-2")], {
      assignments: [{ item_id: "o2", new_class_key: "n2" }],
      new_classes: [
        {
          key: "n2",
          component: "模型自身推理",
          label: "计算错误",
          definition: "计算过程出错。",
          closest_existing: Object.values(library.classes)[0]!.id,
          novelty: "与算术错误措辞不同。", category_paths: [["数值可靠性"]],
        },
      ],
      merges: [],
    }),
  );
  const [keepRef, dropRef] = Object.values(library.classes);
  library = applyClustering(
    library,
    receipt([], {
      assignments: [],
      new_classes: [],
      merges: [{ into: keepRef!.id, from: [dropRef!.id], reason: "同一现象。" }],
    }),
  );
  const keep = library.classes[keepRef!.id]!,
    drop = library.classes[dropRef!.id]!;
  assert.equal(drop.status, "merged");
  assert.equal(drop.merged_into, keep.id);
  assert(keep.aliases.includes("计算错误"));
  assert.equal(library.occurrences.filter((item) => item.class_id === keep.id).length, 2);
  assert(library.occurrences.some((item) => item.previous_class_id === drop.id));
  assert(library.events.some((event) => event.type === "class_merged"));
  assert.equal(resolveActiveClass(library, drop.id)!.id, keep.id);

  const replayed = applyClustering(
    library,
    receipt([], {
      assignments: [],
      new_classes: [],
      merges: [{ into: keep.id, from: [drop.id], reason: "同一现象。" }],
    }),
  );
  assert.equal(replayed.occurrences.length, library.occurrences.length, "re-apply is idempotent");
  assert.equal(
    replayed.events.filter((event) => event.type === "class_merged").length,
    library.events.filter((event) => event.type === "class_merged").length,
  );
});

test("identical labels on different tools create distinct classes and retain their components", () => {
  const library = applyClustering(
    emptyLibrary("a_fast"),
    receipt([observation("o1", "工具A", "超时", "in-1"), observation("o2", "工具B", "超时", "in-2")], {
      assignments: [
        { item_id: "o1", new_class_key: "n1" },
        { item_id: "o2", new_class_key: "n2" },
      ],
      new_classes: [
        { key: "n1", component: "工具A", label: "超时", definition: "工具A超时。", closest_existing: null, novelty: "首次出现。", category_paths: [["数值可靠性"]] },
        { key: "n2", component: "工具B", label: "超时", definition: "工具B超时。", closest_existing: null, novelty: "首次出现。", category_paths: [["数值可靠性"]] },
      ],
      merges: [],
    }),
  );
  assert.equal(Object.keys(library.classes).length, 2);
  assert.equal(new Set(Object.values(library.classes).map((problem) => problem.component_id)).size, 2);
});

test("a merged label resolves to the surviving class instead of creating a duplicate", () => {
  let library = emptyLibrary("a_fast");
  library = applyClustering(
    library,
    receipt(
      [observation("o1", "模型自身推理", "算术错误", "in-1"), observation("o2", "模型自身推理", "计算错误", "in-2")],
      {
        assignments: [
          { item_id: "o1", new_class_key: "n1" },
          { item_id: "o2", new_class_key: "n2" },
        ],
        new_classes: [
          { key: "n1", component: "模型自身推理", label: "算术错误", definition: "d", closest_existing: null, novelty: "n", category_paths: [["数值可靠性"]] },
          { key: "n2", component: "模型自身推理", label: "计算错误", definition: "d", closest_existing: null, novelty: "n", category_paths: [["数值可靠性"]] },
        ],
        merges: [],
      },
    ),
  );
  const [keep, drop] = Object.values(library.classes);
  library = applyClustering(
    library,
    receipt([], {
      assignments: [],
      new_classes: [],
      merges: [{ into: keep!.id, from: [drop!.id], reason: "同一现象。" }],
    }),
  );
  library = applyClustering(
    library,
    receipt([observation("o3", "模型自身推理", "计算错误", "in-3")], {
      assignments: [{ item_id: "o3", new_class_key: "n3" }],
      new_classes: [
        { key: "n3", component: "模型自身推理", label: "计算错误", definition: "d", closest_existing: keep!.id, novelty: "n", category_paths: [["数值可靠性"]] },
      ],
      merges: [],
    }),
  );
  assert.equal(
    Object.values(library.classes).filter((problem) => problem.status === "active").length,
    1,
    "the merged alias reuses the surviving class",
  );
  assert.equal(library.occurrences.filter((item) => item.class_id === keep!.id).length, 3);
});

test("directory updates preserve UUID, source samples and an idempotent before/after audit", () => {
  const original = applyClustering(emptyLibrary("a_fast"), receipt([observation("o1", "模型自身推理", "旧标签", "in-1")], {
    assignments: [{ item_id: "o1", new_class_key: "new" }],
    new_classes: [{ key: "new", component: "模型自身推理", label: "旧标签", definition: "旧定义", closest_existing: null, novelty: "首例", category_paths: [["可靠性", "引用"]] }], merges: [],
  }));
  const id = Object.keys(original.classes)[0]!, before = structuredClone(original), occurrence = original.occurrences[0]!;
  const update = receipt([], { assignments: [], new_classes: [], merges: [],
    class_updates: [{ class_id: id, label: "引用无法解析", definition: "依据真实来源标识判断映射，来源支持主张另行核查。", category_paths: [["来源溯源", "映射"]], reason: "调用次数不能证明来源编号错误。" }] });
  update.submission_id = "maintenance-1";
  const changed = applyClustering(original, update), problem = changed.classes[id]!;
  assert.deepEqual(original, before, "copy-on-write preserves the input directory");
  assert.equal(problem.component_id, original.classes[id]!.component_id);
  assert.deepEqual(problem.first_seen, original.classes[id]!.first_seen);
  assert.deepEqual(changed.occurrences[0], occurrence);
  assert(problem.aliases.includes("旧标签"));
  const event = changed.events.find(event => event.type === "class_updated")!;
  assert.deepEqual(event.detail.before, { label: "旧标签", definition: "旧定义", category_paths: [["可靠性", "引用"]] });
  assert.equal((event.detail.after as { definition: string }).definition, problem.definition);
  assert.equal(event.detail.reason, "调用次数不能证明来源编号错误。");
  assert.equal(applyClustering(changed, update), changed);
  const later = applyClustering(changed, { ...update, submission_id: "maintenance-2", at: "2026-01-03T00:00:00.000Z", result: {
    assignments: [], new_classes: [], merges: [], class_updates: [{ class_id: id, definition: "后续独立复核后的边界。", reason: "再次维护。" }],
  } });
  assert.equal(applyClustering(later, update), later, "old replay cannot roll back a later accepted maintenance");
});

test("deferred assignments record no class or occurrence and do not refresh the library", () => {
  const library = emptyLibrary("a_fast");
  assert.equal(applyClustering(library, receipt([observation("o1", "模型自身推理", "新现象", "in-1")], {
    assignments: [{ item_id: "o1", deferred_reason: "新增预算为零。" }], new_classes: [], merges: [],
  })), library);
});

test("merge organization preserves the full pre-update topic union in its audit", () => {
  let library = applyClustering(emptyLibrary("model"), receipt([
    observation("o1", "模型自身推理", "现象一", "in-1"), observation("o2", "模型自身推理", "现象二", "in-2"),
  ], { assignments: [{ item_id: "o1", new_class_key: "n1" }, { item_id: "o2", new_class_key: "n2" }], merges: [], new_classes: [
    { key: "n1", component: "模型自身推理", label: "现象一", definition: "原定义。", closest_existing: null, novelty: "首例", category_paths: [["一"]] },
    { key: "n2", component: "模型自身推理", label: "现象二", definition: "近义定义。", closest_existing: null, novelty: "首例", category_paths: [["二"]] },
  ] }));
  const [first, second] = Object.values(library.classes);
  const merge = { ...receipt([], { assignments: [], new_classes: [], merges: [{ into: first!.id, from: [second!.id], reason: "同义合并。" }],
    class_updates: [{ class_id: first!.id, category_paths: [["统一主题"]], reason: "合并后的两条路径统一整理。" }] }), submission_id: "organized-merge" };
  library = applyClustering(library, merge);
  const event = library.events.find(event => event.type === "class_updated")!;
  assert.deepEqual((event.detail.before as { category_paths: string[][] }).category_paths, [["一"], ["二"]]);
  assert.deepEqual((event.detail.after as { category_paths: string[][] }).category_paths, [["统一主题"]]);
  assert.equal((event.detail.before as { definition: string }).definition, "原定义。");
  assert.deepEqual(library.classes[first!.id]!.category_paths, [["统一主题"]]);
  assert.equal(library.classes[second!.id]!.status, "merged");
  assert.equal(applyClustering(library, merge), library);
});

test("Applying a receipt rejects invalid new and updated category names before directory changes", () => {
  const original = applyClustering(emptyLibrary("model"), receipt([observation("o1", "模型自身推理", "原类", "in-1")], {
    assignments: [{ item_id: "o1", new_class_key: "n1" }], merges: [], new_classes: [
      { key: "n1", component: "模型自身推理", label: "原类", definition: "原定义。", closest_existing: null, novelty: "首例", category_paths: [["可靠性"]] },
    ],
  }));
  const id = Object.keys(original.classes)[0]!, marked = "主题<[标记]>{", before = structuredClone(original);
  const create = receipt([], { assignments: [], merges: [], new_classes: [
    { key: "n2", component: "新增组件", label: "新增类", definition: "新定义。", closest_existing: null, novelty: "首例", category_paths: [[marked]] },
  ], class_updates: [{ class_id: id, label: "修改标签", reason: "先修改目录。" }] });
  const update = receipt([], { assignments: [], merges: [], new_classes: [],
    class_updates: [{ class_id: id, label: "修改标签", category_paths: [[marked]], reason: "整理主题。" }] });
  for (const [input, path] of [[create, "/new_classes/0/category_paths/0/0"], [update, "/class_updates/0/category_paths/0/0"]] as const) {
    const submitted = structuredClone(input);
    assert.throws(() => applyClustering(original, input), error => {
      assert(error instanceof ValidationError);
      assert.deepEqual(error.issues!.map(issue => issue.path), [path]);
      assert.deepEqual(error.issues!.map(issue => issue.actual), [marked]);
      return true;
    });
    assert.deepEqual(original, before);
    assert.deepEqual(input, submitted);
  }
});

test("Merge guards only resulting topic paths and allows explicit correction without rewriting unrelated history", () => {
  const original = topicLibrary();
  const [keep, drop] = Object.values(original.classes);
  // Previously stored material remains readable; only paths proposed for this write are checked.
  drop!.category_paths = [["历史<标记>"]];
  const before = structuredClone(original);
  const unrelated = applyClustering(original, { ...receipt([], { assignments: [], new_classes: [], merges: [],
    class_updates: [{ class_id: keep!.id, definition: "精确的新定义。", reason: "核对边界。" }] }), submission_id: "unrelated" });
  assert.deepEqual(unrelated.classes[drop!.id]!.category_paths, drop!.category_paths);
  const merge = receipt([], { assignments: [], new_classes: [], merges: [{ into: keep!.id, from: [drop!.id], reason: "同义合并。" }] });
  assert.throws(() => applyClustering(original, merge), error => {
    assert(error instanceof ValidationError);
    assert.equal(error.issues![0]!.path, "/merges/0/category_paths/1/0");
    assert.equal(error.issues![0]!.actual, "历史<标记>");
    return true;
  });
  assert.deepEqual(original, before);
  merge.result.class_updates = [{ class_id: keep!.id, category_paths: [["统一主题"]], reason: "明确整理合并目录。" }];
  const corrected = applyClustering(original, merge);
  assert.deepEqual(corrected.classes[keep!.id]!.category_paths, [["统一主题"]]);
  assert.equal(corrected.classes[drop!.id]!.status, "merged");
  assert.deepEqual(original, before);
});


test("Already applied directory updates skip old invalid paths without rolling back current topics", () => {
  const library = topicLibrary(), id = Object.keys(library.classes)[0]!;
  const replay = receipt([], { assignments: [], new_classes: [], merges: [], class_updates: [
    { class_id: id, definition: "旧定义。", category_paths: [["旧<标记>"]], reason: "旧维护。" },
  ] });
  library.events.push({ id: "old-maintenance", type: "class_updated", at: replay.at!,
    detail: { submission_id: replay.submission_id, class_id: id } });
  const before = structuredClone(library);
  assert.equal(applyClustering(library, replay), library);
  assert.deepEqual(library, before);
});

test("Reusing an existing class alias ignores unwritten topic paths in an old creation receipt", () => {
  const library = topicLibrary();
  Object.values(library.classes)[0]!.aliases.push("旧同义名");
  const before = structuredClone(library);
  const replay = receipt([], { assignments: [], merges: [], new_classes: [
    { key: "old", component: "模型自身推理", label: "旧同义名", definition: "旧定义。", closest_existing: null, novelty: "旧建类。", category_paths: [["旧<标记>"]] },
  ] });
  assert.equal(applyClustering(library, replay), library);
  assert.deepEqual(library, before);
});

test("An already applied explicit update cannot bypass dirty topic union validation during a new merge", () => {
  const library = topicLibrary(), [keep, drop] = Object.values(library.classes);
  drop!.category_paths = [["历史<标记>"]];
  const replay = receipt([], { assignments: [], new_classes: [], merges: [{ into: keep!.id, from: [drop!.id], reason: "合并现象。" }],
    class_updates: [{ class_id: keep!.id, category_paths: [["已应用的有效主题"]], reason: "旧维护。" }] });
  library.events.push({ id: "old-maintenance", type: "class_updated", at: replay.at!,
    detail: { submission_id: replay.submission_id, class_id: keep!.id } });
  const before = structuredClone(library);
  assert.throws(() => applyClustering(library, replay), error => {
    assert(error instanceof ValidationError);
    assert.equal(error.issues![0]!.path, "/merges/0/category_paths/1/0");
    assert.equal(error.issues![0]!.actual, "历史<标记>");
    return true;
  });
  assert.deepEqual(library, before);
});


test("An already applied update cannot bypass the primary path budget during a new merge", () => {
  const library = topicLibrary(), [keep, drop] = Object.values(library.classes);
  const replay = receipt([], { assignments: [], new_classes: [], merges: [{ into: keep!.id, from: [drop!.id], reason: "合并现象。" }],
    class_updates: [{ class_id: keep!.id, category_paths: [["旧<标记>"]], reason: "旧维护。" }] });
  library.events.push({ id: "old-maintenance", type: "class_updated", at: replay.at!,
    detail: { submission_id: replay.submission_id, class_id: keep!.id } });
  const before = structuredClone(library);
  assert.throws(() => applyClustering(library, replay), /只能保留一条主要主题路径/);
  assert.deepEqual(library, before);
  replay.submission_id = "new-maintenance";
  replay.result.class_updates = [{ class_id: keep!.id, category_paths: [["有效主题"]], reason: "统一合并后的主要路径。" }];
  const changed = applyClustering(library, replay);
  assert.deepEqual(changed.classes[keep!.id]!.category_paths, [["有效主题"]]);
  assert.equal(changed.classes[drop!.id]!.status, "merged");
  assert.deepEqual(library, before);
  assert.equal(applyClustering(changed, replay), changed);
});

test("library recalls at most three independent effective answers with source identities", () => {
  const observations = ["a", "b", "c", "u"].map(id => observation(`o-${id}`, "模型自身推理", "计算错误", id));
  observations.forEach((item, index) => {
    item.refs[0]!.batch_id = index < 2 ? "2026-10-01" : "2026-10-02";
    item.refs[0]!.attribution = { run: "/runs/source", run_id: "source", task_id: `attr-${index}`,
      submission_id: `submission-${index}`, evaluator_version: "test" };
  });
  observations[3]!.refs[0]!.evidence_status = "uncertain";
  observations[3]!.established_answer_ids = [];
  observations[0]!.refs.push({ ...observations[0]!.refs[0]!, finding_id: "same-answer-second-finding" });
  const library = applyClustering(emptyLibrary("model"), receipt(observations, {
    assignments: observations.map(item => ({ item_id: item.id, new_class_key: "n1" })), merges: [],
    new_classes: [{ key: "n1", component: "模型自身推理", label: "计算错误", definition: "计算结果与数据不符。", closest_existing: null, novelty: "首例。", category_paths: [["数值可靠性"]] }],
  }));
  const [problem] = projectLibrary(library).components[0]!.classes;
  assert.equal(problem!.examples.length, 3);
  assert.equal(new Set(problem!.examples.map(item => item.input_id)).size, 3);
  assert.equal(problem!.examples[0]!.evidence_status, "established");
  assert(problem!.examples.some(item => item.evidence_status === "uncertain"));
  assert.equal(new Set(problem!.examples.map(item => item.batch_id)).size, 2);
  assert(problem!.examples.every(item => item.attribution?.run === "/runs/source" && item.finding_id));
  assert.equal(problem!.occurrences, 5);
  assert(!("finding" in problem!.examples[0]!), "the persisted library never duplicates full accepted finding text");
  assert(!("quote" in problem!.examples[0]!), "a resumable directory projection retains source references without copying input text");
});
