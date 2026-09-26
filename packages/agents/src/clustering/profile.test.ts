import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRequest } from "@eval/contracts";
import { clusteringAgent, clusteringProfile } from "./index.js";
import type { ClusteringRequest, ClusteringResult } from "./types.js";
import example from "./profiles/default/example.json" with { type: "json" };

const audit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] };
const request = () => structuredClone(example.request) as unknown as AgentRequest;
const requestInput = (value: AgentRequest) => value.input as unknown as ClusteringRequest;
const result = () => structuredClone(example.result) as unknown as ClusteringResult;

test("Clustering assigns every observation and caps new classes", () => {
  assert.deepEqual(Object.keys(clusteringAgent.profiles), ["default"]);
  clusteringProfile.validate!(example.request, example.result, audit);

  const missing = result();
  missing.assignments.pop();
  assert.throws(() => clusteringProfile.validate!(request(), missing, audit), /每个观察都必须归类/);

  const unknownClass = result();
  unknownClass.assignments[0]!.class_id = "missing";
  assert.throws(() => clusteringProfile.validate!(request(), unknownClass, audit), /活跃问题类/);

  const unknownKey = result();
  unknownKey.assignments[1]!.new_class_key = "missing";
  assert.throws(() => clusteringProfile.validate!(request(), unknownKey, audit), /必须已在/);

  const unused = result();
  unused.assignments = unused.assignments.filter((assignment) => assignment.item_id !== "o2");
  assert.throws(() => clusteringProfile.validate!(request(), unused, audit), /每个观察都必须归类|至少覆盖/);

  const duplicate = result();
  duplicate.new_classes[0]!.label = "算术错误";
  assert.throws(() => clusteringProfile.validate!(request(), duplicate, audit), /必须把观察归入该 class_id/);

  const uncompared = result();
  uncompared.new_classes[0]!.closest_existing = null;
  assert.throws(() => clusteringProfile.validate!(request(), uncompared, audit), /最接近的已有问题类/);

  const overBudget = request();
  requestInput(overBudget).budget.max_new_classes = 0;
  assert.throws(() => clusteringProfile.validate!(overBudget, result(), audit), /超过本次预算/);

  const atCap = request();
  requestInput(atCap).budget.active_classes = 80;
  requestInput(atCap).budget.max_classes = 80;
  assert.throws(() => clusteringProfile.validate!(atCap, result(), audit), /超过每模型上限/);

  const weakSupport = request();
  requestInput(weakSupport).budget.min_support = 5;
  assert.throws(() => clusteringProfile.validate!(weakSupport, result(), audit), /出现样本不足/);

  const blankLabel = result();
  blankLabel.new_classes[0]!.label = "  ";
  assert.throws(() => clusteringProfile.validate!(request(), blankLabel, audit), /问题名称不能为空/);
});

test("clustering keeps problem classes within their component", () => {
  const differentTool = request();
  requestInput(differentTool).items[1]!.component = "搜索工具";
  requestInput(differentTool).items[1]!.label = "算术错误";
  const sameLabel = result();
  sameLabel.new_classes[0]!.component = "搜索工具";
  sameLabel.new_classes[0]!.label = "算术错误";
  clusteringProfile.validate!(differentTool, sameLabel, audit);

  const wrongComponent = result();
  wrongComponent.new_classes[0]!.component = "搜索工具";
  assert.throws(() => clusteringProfile.validate!(request(), wrongComponent, audit), /组件.*不一致/);

  const wrongExisting = request();
  requestInput(wrongExisting).items[0]!.component = "搜索工具";
  const assignment = result();
  assignment.new_classes[0]!.component = "模型自身推理";
  assert.throws(() => clusteringProfile.validate!(wrongExisting, assignment, audit), /组件.*不一致/);

  const crossMerge = request();
  requestInput(crossMerge).library.components.push({
    id: "component-tool", label: "搜索工具", definition: "", aliases: [],
    classes: [{ id: "class-tool", label: "算术错误", definition: "d", aliases: [], occurrences: 1 }],
  });
  const crossResult = result();
  crossResult.merges = [{ into: "class-arithmetic", from: ["class-tool"], reason: "名字相同" }];
  assert.throws(() => clusteringProfile.validate!(crossMerge, crossResult, audit), /同一组件/);
});

test("Clustering merges must target existing active classes exactly once", () => {
  const selfMerge = result();
  selfMerge.merges = [{ into: "class-arithmetic", from: ["class-arithmetic"], reason: "x" }];
  assert.throws(() => clusteringProfile.validate!(request(), selfMerge, audit), /不能把类合并到自己/);

  const unknown = result();
  unknown.merges = [{ into: "missing", from: ["class-arithmetic"], reason: "x" }];
  assert.throws(() => clusteringProfile.validate!(request(), unknown, audit), /into 必须是库中活跃问题类/);

  const overlap = result();
  overlap.merges = [{ into: "class-arithmetic", from: ["class-arithmetic", "class-arithmetic"], reason: "x" }];
  assert.throws(
    () => clusteringProfile.validate!(request(), overlap, audit),
    /只能作为一次合并的源|不能把类合并到自己/,
  );
});
