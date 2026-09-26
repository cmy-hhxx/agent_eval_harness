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
import type { ClusteringResult } from "./types.js";

const observation = (id: string, component: string, label: string, inputId: string): ClusteringObservation => ({
  id,
  component,
  label,
  definition: `${label}。`,
  count: 1,
  examples: [
    {
      finding: label,
      reason: "r",
      dimension: "correctness",
      importance: "high",
      stage: "final_answer",
    },
  ],
  refs: [
    {
      input_id: inputId,
      case_id: `case-${inputId}`,
      source: { file: "f.jsonl", line: 7 },
      finding_id: `f-${id}`,
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

test("clustering creates components and classes and keeps occurrence lineage", () => {
  let library = emptyLibrary("a_fast");
  const observations = [observation("o1", "色值工具", "色值错误", "in-1")];
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
          novelty: "首个问题。",
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
  assert.equal(library.occurrences[0]!.classification, "created");

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
      key: "n1", component: "色值工具", label: "色值错误", definition: "颜色值与要求不符。", closest_existing: null, novelty: "首个问题。",
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
          novelty: "首个问题。",
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
          novelty: "与算术错误措辞不同。",
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
        { key: "n1", component: "工具A", label: "超时", definition: "工具A超时。", closest_existing: null, novelty: "首次出现。" },
        { key: "n2", component: "工具B", label: "超时", definition: "工具B超时。", closest_existing: null, novelty: "首次出现。" },
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
          { key: "n1", component: "模型自身推理", label: "算术错误", definition: "d", closest_existing: null, novelty: "n" },
          { key: "n2", component: "模型自身推理", label: "计算错误", definition: "d", closest_existing: null, novelty: "n" },
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
        { key: "n3", component: "模型自身推理", label: "计算错误", definition: "d", closest_existing: keep!.id, novelty: "n" },
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
