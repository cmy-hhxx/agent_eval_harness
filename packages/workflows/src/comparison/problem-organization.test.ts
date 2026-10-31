import test from "node:test";
import assert from "node:assert/strict";
import { applyClustering, countProblemSamples, emptyLibrary, projectLibrary, type ClusteringObservation } from "@eval/agents/clustering";

const observation = (id: string, component: string): ClusteringObservation => ({
  id, component, label: "来源问题", definition: "来源信息与主张不一致。", count: 1, established_count: 1, uncertain_count: 0, established_answer_ids: ["input"],
  examples: [], refs: [{ input_id: "input", problem_path: "finding", case_id: "case", source: { file: "source", line: 1 },
    message_index: 3, quote: "q", evidence_status: "已确认" }],
});

test("component projections preserve one defect identity", () => {
  const library = applyClustering(emptyLibrary("model"), {
    run_id: "run", evaluator_version: "test", task_id: "task", submission_id: "submission", version: "model", batch_id: "batch",
    observations: [observation("o1", "模型自身推理"), observation("o2", "Search")],
    result: { assignments: [{ item_id: "o1", new_class_key: "model" }, { item_id: "o2", new_class_key: "tool" }], merges: [],
      new_classes: [
        { key: "model", component: "模型自身推理", label: "来源误读", definition: "模型误读来源。", closest_existing: null, novelty: "首例。",
          category: "事实可靠性" },
        { key: "tool", component: "Search", label: "返回有误", definition: "返回存在缺陷。", closest_existing: null, novelty: "首例。",
          category: "事实可靠性" },
      ] },
  });
  assert.equal(library.occurrences.length, 2, "all source responsibility associations remain stored");
  assert.equal(countProblemSamples(library.occurrences), 1);
  assert(projectLibrary(library).components.every(component => component.classes[0]!.occurrences === 1));
});
