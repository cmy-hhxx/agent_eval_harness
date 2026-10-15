import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type AgentRequest } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { applyClustering, clusteringAgent, clusteringProfile, emptyLibrary, projectLibrary } from "./index.js";
import { categoryPathIssues } from "./organization.js";
import type { ClusteringRequest, ClusteringResult, ClusteringSubmission } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const request = () => structuredClone(example.request) as unknown as AgentRequest;
const requestInput = (value: AgentRequest) => value.input as unknown as ClusteringRequest;
const result = () => structuredClone(example.result) as unknown as ClusteringResult;

test("assignment selects the exact class name within its component, independent of directory numbering", () => {
  const bound = request(), input = requestInput(bound), component = input.library.components[0]!;
  input.items = [input.items[0]!];
  const wanted = component.classes[0]!;
  component.classes.unshift({ ...wanted, id: "unrelated", label: "未知用户风险画像" });
  input.library.components.push({ ...component, id: "other-component", label: "另一个工具", aliases: [],
    classes: [{ ...wanted, id: "same-label-other-component" }] });
  const draft = { assignments: [{ item_id: "O1", class_label: wanted.label }], new_classes: [], merges: [] };
  const resolve = () => clusteringProfile.resolve!(bound, draft, audit) as ClusteringResult;
  assert.deepEqual(resolve().assignments, [{ item_id: input.items[0]!.id, class_id: wanted.id }]);
  component.classes.reverse();
  assert.deepEqual(resolve().assignments, [{ item_id: input.items[0]!.id, class_id: wanted.id }]);
  draft.assignments[0]!.class_label = "目录中没有这个类";
  assert.throws(resolve, error => {
    assert(error instanceof ValidationError);
    assert.equal(error.issues?.[0]?.path, "/assignments/0/class_label");
    assert.deepEqual(error.issues?.[0]?.expected, component.classes.map(c => c.label));
    return true;
  });
});

test("assignment-only recall cannot change the directory", () => {
  const bound = request(); requestInput(bound).budget.assignment_only = true;
  assert.throws(() => clusteringProfile.validate!(bound, result(), audit), /回捞只允许/);
  const empty = request(); requestInput(empty).items = []; requestInput(empty).budget.assignment_only = true;
  const id = requestInput(empty).library.components[0]!.classes[0]!.id;
  assert.throws(() => clusteringProfile.validate!(empty, { assignments: [], new_classes: [], merges: [],
    class_updates: [{ class_id: id, definition: "扩大范围。", reason: "尝试改目录" }] }, audit), /回捞只允许/);
  assert.doesNotThrow(() => clusteringProfile.validate!(empty, { assignments: [], new_classes: [], merges: [] }, audit));
});
const submission = (): ClusteringSubmission => {
  const canonical = result();
  const input = requestInput(request());
  const classes = input.library.components.flatMap(component => component.classes);
  const classReference = (id: string) => `C${classes.findIndex(entry => entry.id === id) + 1}`;
  return {
    assignments: canonical.assignments.map(({ item_id, class_id, new_class_key, ...entry }) => ({
      ...entry,
      item_id: `O${input.items.findIndex(item => item.id === item_id) + 1}`,
      ...(class_id === undefined ? {} : { class_label: classes.find(entry => entry.id === class_id)!.label }),
      ...(new_class_key === undefined ? {} : {
        new_class_index: canonical.new_classes.findIndex(entry => entry.key === new_class_key),
      }),
    })),
    new_classes: canonical.new_classes.map(({ key: _key, closest_existing, ...entry }) => ({
      ...entry,
      ...(closest_existing === null ? {} : { closest_existing: classReference(closest_existing) }),
    })),
    merges: canonical.merges.map(entry => ({ ...entry, into: classReference(entry.into), from: entry.from.map(classReference) })),
  };
};

test("Clustering binds a new class by position and fills an empty component's comparison without model copying", () => {
  const registry = new AgentRegistry([clusteringAgent]);
  const bound = request(), input = requestInput(bound), draft = submission();
  input.items = [input.items[1]!];
  input.library.components = [];
  input.budget.active_classes = 0;
  input.budget.active_components = 0;
  draft.assignments = [{ item_id: "O1", new_class_index: 0 }];
  delete draft.new_classes[0]!.closest_existing;
  const binding = { agent: "clustering", profile: "default", request: bound };
  const before = structuredClone({ bound, draft });
  // A declaration's prose can change between repairs without breaking its assignment.
  for (const label of ["风险提示开篇边界越位", "风险提示开篇开篇越位"]) {
    draft.new_classes[0]!.label = label;
    const resolved = registry.resolve(binding, draft, audit) as ClusteringResult;
    registry.validate(binding, resolved, audit);
    assert.deepEqual(resolved.assignments, [{ item_id: "o2", new_class_key: "n1" }]);
    assert.equal(resolved.new_classes[0]!.key, "n1");
    assert.equal(resolved.new_classes[0]!.closest_existing, null);
    assert.equal(resolved.new_classes[0]!.component, draft.new_classes[0]!.component);
    assert(!("new_class_index" in resolved.assignments[0]!));
    assert(!("key" in draft.new_classes[0]!));
  }
  assert.deepEqual(bound, before.bound);
  assert.equal(draft.assignments[0]!.new_class_index, 0);
  assert(!("closest_existing" in draft.new_classes[0]!));
  input.budget.max_new_classes = 0;
  const resolved = registry.resolve(binding, draft, audit);
  assert.throws(() => registry.validate(binding, resolved, audit), /超过 budget\.max_new_classes/);
});

test("Clustering requires a real new-class position and offers only current declaration positions", () => {
  const registry = new AgentRegistry([clusteringAgent]);
  const binding = { agent: "clustering", profile: "default", request: request() };
  const draft = submission();
  draft.assignments[1]!.new_class_index = 1;
  assert.throws(() => registry.resolve(binding, draft, audit), error => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues!.map(({ code, path }) => ({ code, path })), [
      { code: "clustering_new_class_index", path: "/assignments/1/new_class_index" },
    ]);
    assert.deepEqual(error.issues![0]!.expected, { available_new_classes: [
      { index: 0, component: "模型自身推理", label: "单位换算遗漏" },
    ] });
    return true;
  });
  for (const invalid of [-1, 0.5]) {
    draft.assignments[1]!.new_class_index = invalid;
    assert.throws(() => registry.resolve(binding, draft, audit), ValidationError);
  }
  draft.assignments[1]!.new_class_index = 0;
  draft.new_classes = [];
  assert.throws(() => registry.resolve(binding, draft, audit), error => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues![0]!.expected, { available_new_classes: [] });
    return true;
  });
});

test("Clustering keeps declaration positions through reorder and permits multiple observations to select one class", () => {
  const registry = new AgentRegistry([clusteringAgent]);
  const bound = request(), draft = submission();
  draft.new_classes.push({ ...draft.new_classes[0]!, label: "来源核对遗漏", definition: "模型给出来源结论前未核对工具中的原始字段。" });
  draft.assignments[0] = { item_id: "O1", new_class_index: 1 };
  const binding = { agent: "clustering", profile: "default", request: bound };
  for (const reverse of [false, true]) {
    if (reverse) draft.new_classes.reverse();
    const resolved = registry.resolve(binding, draft, audit) as ClusteringResult;
    registry.validate(binding, resolved, audit);
    assert.equal(resolved.assignments[0]!.new_class_key, resolved.new_classes[1]!.key);
    assert.equal(resolved.assignments[1]!.new_class_key, resolved.new_classes[0]!.key);
    assert.equal(resolved.new_classes[1]!.label, draft.new_classes[1]!.label);
  }
  draft.new_classes = [draft.new_classes[0]!];
  draft.assignments[0]!.new_class_index = 0;
  const shared = registry.resolve(binding, draft, audit) as ClusteringResult;
  registry.validate(binding, shared, audit);
  assert.deepEqual(shared.assignments.map(entry => entry.new_class_key), ["n1", "n1"]);
});

test("Clustering cannot omit a closest class when its component has candidates, including aliases", () => {
  const registry = new AgentRegistry([clusteringAgent]);
  const bound = request(), input = requestInput(bound), draft = submission();
  input.library.components[0]!.aliases = ["推理"];
  input.library.components.push({ id: "component-tool", label: "搜索工具", definition: "", aliases: [],
    classes: [{ id: "class-tool", label: "搜索覆盖不足", definition: "d", aliases: [], occurrences: 1, examples: [] }] });
  input.items[1]!.component = "推理";
  draft.new_classes[0]!.component = " 推理 ";
  delete draft.new_classes[0]!.closest_existing;
  const before = structuredClone({ bound, draft });
  const binding = { agent: "clustering", profile: "default", request: bound };
  assert.throws(() => registry.resolve(binding, draft, audit), error => {
    assert(error instanceof ValidationError);
    assert.equal(error.issues!.length, 1);
    assert.equal(error.issues![0]!.code, "clustering_new_class_uncompared");
    assert.equal(error.issues![0]!.path, "/new_classes/0/closest_existing");
    assert.deepEqual(error.issues![0]!.expected, { available_classes: [
      { id: "C1", label: "算术错误", component: "模型自身推理" },
    ] });
    return true;
  });
  assert.deepEqual({ bound, draft }, before);
  draft.new_classes[0]!.closest_existing = "C1";
  const resolved = registry.resolve(binding, draft, audit);
  registry.validate(binding, resolved, audit);
});

test("Clustering fills null from this component's candidates rather than the whole library", () => {
  const registry = new AgentRegistry([clusteringAgent]);
  const bound = request(), input = requestInput(bound), draft = submission();
  input.items = [input.items[1]!];
  input.library.components[0]!.classes = [];
  input.library.components.push({ id: "component-tool", label: "搜索工具", definition: "", aliases: [],
    classes: [{ id: "class-tool", label: "搜索覆盖不足", definition: "d", aliases: [], occurrences: 1, examples: [] }] });
  draft.assignments = [{ item_id: "O1", new_class_index: 0 }];
  delete draft.new_classes[0]!.closest_existing;
  const binding = { agent: "clustering", profile: "default", request: bound };
  const resolved = registry.resolve(binding, draft, audit) as ClusteringResult;
  registry.validate(binding, resolved, audit);
  assert.equal(resolved.new_classes[0]!.closest_existing, null);
  draft.new_classes[0]!.closest_existing = "C1";
  assert.throws(() => registry.validate(binding, registry.resolve(binding, draft, audit), audit), /只能比较同组件/);
});

test("Clustering schema feedback shows string-only topic paths without converting an invalid draft", () => {
  const registry = new AgentRegistry([clusteringAgent]);
  const bound = request();
  const binding = { agent: "clustering", profile: "default", request: bound };
  const draft = submission();
  draft.new_classes[0]!.category_paths = [[{ item: "风格禁令" }]] as unknown as string[][];
  draft.class_updates = [{ class_id: "C1", category_paths: [[{ item: "数值可靠性" }]] as unknown as string[][], reason: "整理主题。" }];
  const before = structuredClone({ bound, draft });
  assert.throws(() => registry.resolve(binding, draft, audit), error => {
    assert(error instanceof ValidationError);
    const issues = error.issues!.filter(issue => issue.code === "schema_type");
    assert.deepEqual(issues.map(issue => issue.path), ["/new_classes/0/category_paths/0/0", "/class_updates/0/category_paths/0/0"]);
    for (const issue of issues) {
      const expected = issue.expected as Record<string, unknown>;
      assert.deepEqual(expected.category_paths_example, [["指令遵循"]]);
      assert.equal(expected.type, "string");
      assert.match(String(expected.category_paths_rule), /直接填写字符串/);
      assert.equal(typeof issue.actual, "object");
    }
    return true;
  });
  assert.deepEqual({ bound, draft }, before);
  draft.new_classes[0]!.category_paths = [["指令遵循"]];
  draft.class_updates![0]!.category_paths = [["计算与逻辑错误"]];
  const resolved = registry.resolve(binding, draft, audit);
  registry.validate(binding, resolved, audit);
  assert.deepEqual((resolved as ClusteringResult).new_classes[0]!.category_paths, draft.new_classes[0]!.category_paths);
});

test("Clustering assigns every observation and caps new classes", () => {
  assert.deepEqual(Object.keys(clusteringAgent.profiles), ["default"]);
  clusteringProfile.validate!(example.request, example.result, audit);

  const missing = result();
  missing.assignments.pop();
  assert.throws(() => clusteringProfile.validate!(request(), missing, audit), /每个观察都必须归类/);

  const unknownClass = result();
  unknownClass.assignments[0]!.class_id = "missing";
  assert.throws(() => clusteringProfile.validate!(request(), unknownClass, audit), (error) => {
    assert(error instanceof ValidationError);
    const issue = error.issues?.find((item) => item.code === "clustering_class_unknown");
    assert(issue);
    assert.deepEqual(issue.expected, { available_classes: [
      { id: "C1", label: "算术错误", component: "模型自身推理" },
    ] });
    return true;
  });

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
  assert.throws(() => clusteringProfile.validate!(overBudget, result(), audit), /超过 budget\.max_new_classes/);

  const atCap = request();
  requestInput(atCap).budget.active_classes = 80;
  requestInput(atCap).budget.max_classes = 80;
  assert.throws(() => clusteringProfile.validate!(atCap, result(), audit), /超过 budget\.max_classes/);

  const weakSupport = request();
  requestInput(weakSupport).budget.min_support = 5;
  assert.throws(() => clusteringProfile.validate!(weakSupport, result(), audit), /低于 budget\.min_support/);

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
  sameLabel.new_classes[0]!.closest_existing = null;
  clusteringProfile.validate!(differentTool, sameLabel, audit);

  sameLabel.new_classes[0]!.closest_existing = "class-arithmetic";
  assert.throws(() => clusteringProfile.validate!(differentTool, sameLabel, audit), /只能比较同组件/);

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
    classes: [{ id: "class-tool", label: "算术错误", definition: "d", aliases: [], occurrences: 1, examples: [] }],
  });
  const crossResult = result();
  crossResult.merges = [{ into: "class-arithmetic", from: ["class-tool"], reason: "名字相同" }];
  assert.throws(() => clusteringProfile.validate!(crossMerge, crossResult, audit), /同一组件/);
});

test("new classes require confirmed independent answers across all assigned observations", () => {
  const bound = request(), input = requestInput(bound), draft = result();
  input.budget.min_support = 3;
  draft.assignments[0] = { item_id: "o1", new_class_key: "n1" };
  input.items[0]!.established_answer_ids = ["answer1", "answer2"];
  input.items[1]!.established_answer_ids = ["answer2"];
  input.items[1]!.count = 100;
  input.items[1]!.established_count = 20;
  input.items[1]!.uncertain_count = 80;
  assert.throws(() => clusteringProfile.validate!(bound, draft, audit), /已确认独立回答数低于/);
  input.items[1]!.established_answer_ids = ["answer2", "answer3"];
  clusteringProfile.validate!(bound, draft, audit);
  input.items[0]!.established_answer_ids = [];
  input.items[1]!.established_answer_ids = [];
  assert.throws(() => clusteringProfile.validate!(bound, draft, audit), /疑似样本不计支持/);
  draft.new_classes = [];
  draft.assignments = input.items.map(item => ({ item_id: item.id, deferred_reason: "只有疑似样本，等待独立已确认回答。" }));
  clusteringProfile.validate!(bound, draft, audit);
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

test("clustering uses request-local references and persists exact identities for every operation", () => {
  const bound = request();
  const input = requestInput(bound);
  const first = "c183de22-91d1-49a5-a68b-5fc9cd41bd31";
  const second = "c183de22-91d1-49be-a68b-5fc9cd41bd31";
  const observed = "8ab88c05-7851-4dd8-ae09-6006aee4b3fd";
  const component = input.library.components[0]!;
  component.classes[0]!.id = first;
  component.classes.push({ ...component.classes[0]!, id: second, label: "计算失误" });
  input.items[0]!.id = observed;
  const before = structuredClone(bound);
  const draft = submission();
  draft.new_classes[0]!.closest_existing = "C2";
  draft.merges = [{ into: "C1", from: ["C2"], reason: "同一计算错误" }];
  const resolved = clusteringProfile.resolve!(bound, draft, audit) as ClusteringResult;
  assert.equal(resolved.assignments[0]!.class_id, first);
  assert.equal(resolved.assignments[0]!.item_id, observed);
  assert.equal(resolved.assignments[1]!.item_id, "o2");
  assert.equal(resolved.new_classes[0]!.closest_existing, second);
  assert.deepEqual(resolved.merges[0], { into: first, from: [second], reason: "同一计算错误" });
  clusteringProfile.validate!(bound, resolved, audit);
  assert.deepEqual(bound, before, "rendering and resolution must not mutate stored material");
  assert.equal(draft.assignments[0]!.class_label, "算术错误");
  const prompt = clusteringProfile.renderPrompt(bound.input);
  for (const id of [first, second, observed]) assert(!prompt.includes(id), "model material must not require UUID copying");
  assert(prompt.includes('"id":"C1"') && prompt.includes('"id":"C2"') && prompt.includes('"id":"O1"'));

  const reordered = structuredClone(bound);
  requestInput(reordered).library.components[0]!.classes.reverse();
  const reorderedResult = clusteringProfile.resolve!(reordered, draft, audit) as ClusteringResult;
  assert.equal(reorderedResult.assignments[0]!.class_id, first, "class names retain meaning when the directory order changes");
  const resumed = clusteringProfile.renderPrompt(reordered.input, undefined, {
    draft, errors: [{ category: "decision", code: "old", path: "/assignments/0", message: "stale-reference-marker" }],
    contentSubmissions: 1, fileErrors: 0, repeatedErrors: 0, stopped: false, attemptId: "previous",
  });
  assert(!resumed.includes("stale-reference-marker"));
  assert(!resumed.includes('"assignments"'), "a resumed attempt must reselect from the current library, not reuse old local indices");

  for (const invalid of [first, "P1", "C999"]) {
    const bad = structuredClone(draft);
    bad.assignments[0]!.class_label = invalid;
    assert.throws(() => clusteringProfile.resolve!(bound, bad, audit), ValidationError);
  }
  const missing = structuredClone(draft);
  missing.merges[0]!.from = ["C999"];
  assert.throws(() => clusteringProfile.resolve!(bound, missing, audit), (error) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues?.[0]?.expected, ["C1", "C2"]);
    assert.equal(error.issues?.[0]?.path, "/merges/0/from/0");
    return true;
  });
  const duplicate = structuredClone(resolved);
  duplicate.assignments.push({ ...duplicate.assignments[0]! });
  assert.throws(() => clusteringProfile.validate!(bound, duplicate, audit), (error) => {
    assert(error instanceof ValidationError);
    assert.equal(error.issues?.[0]?.actual, "O1");
    assert(!JSON.stringify(error.issues).includes(observed), "repair feedback uses the same short references");
    return true;
  });
});

test("deferred observations require a real creation or support limit and remain exclusive", () => {
  const bound = request(), draft = result();
  requestInput(bound).budget.max_new_classes = 0;
  draft.new_classes = [];
  draft.assignments[1] = { item_id: "o2", deferred_reason: "本次新增类预算为零，已有算术类不涵盖漏查工具结果。" };
  clusteringProfile.validate!(bound, draft, audit);
  assert.throws(() => clusteringProfile.validate!(request(), draft, audit), /不能延期/);
  requestInput(bound).budget.max_new_classes = 8;
  requestInput(bound).budget.min_support = 5;
  clusteringProfile.validate!(bound, draft, audit);
  requestInput(bound).items[0]!.label = "计算错误";
  draft.assignments[0] = { item_id: "o1", deferred_reason: "支持不足。" };
  clusteringProfile.validate!(bound, draft, audit);
  requestInput(bound).items[0]!.definition = requestInput(bound).library.components[0]!.classes[0]!.definition;
  assert.throws(() => clusteringProfile.validate!(bound, draft, audit), /已有同名或别名/);
  draft.assignments[0] = { item_id: "O1", class_id: "C1", deferred_reason: "预算不足。" };
  draft.assignments[1]!.item_id = "O2";
  assert.throws(() => clusteringProfile.resolve!(bound, draft, audit), ValidationError);
});

test("topics and directory maintenance use current class references without changing responsibility", () => {
  const bound = request(), draft = submission();
  draft.new_classes[0]!.category_paths = [["数据理解错误"]];
  draft.class_updates = [{ class_id: "C1", definition: "模型计算步骤与可核验数字不符。", category_paths: [["数值可靠性"]], reason: "界定结果偏差，不推断额外根因。" }];
  const resolved = clusteringProfile.resolve!(bound, draft, audit) as ClusteringResult;
  assert.equal(resolved.class_updates![0]!.class_id, "class-arithmetic");
  clusteringProfile.validate!(bound, resolved, audit);
  const repeat = structuredClone(resolved);
  repeat.new_classes[0]!.category_paths = [["工具使用", "遗漏"], [" 工具使用 ", "遗漏"]];
  assert.throws(() => clusteringProfile.validate!(bound, repeat, audit), ValidationError);
  repeat.new_classes[0]!.category_paths = [["工具使用", " 工具使用 "]];
  assert.throws(() => clusteringProfile.validate!(bound, repeat, audit), ValidationError);
  repeat.new_classes[0]!.category_paths = [["一", "二", "三", "四"]];
  assert.throws(() => clusteringProfile.validate!(bound, repeat, audit), ValidationError);
  const bad = structuredClone(draft) as unknown as Record<string, unknown>;
  bad.class_updates = [{ class_id: "C1", component: "搜索工具", definition: "改归工具。", reason: "改责任。" }];
  assert.throws(() => clusteringProfile.resolve!(bound, bad, audit), ValidationError);
});

test("every new class requires exactly one primary topic path", () => {
  const bound = request(), draft = submission();
  const missing = structuredClone(draft) as unknown as { new_classes: { category_paths?: string[][] }[] };
  delete missing.new_classes[0]!.category_paths;
  assert.throws(() => clusteringProfile.resolve!(bound, missing, audit), ValidationError);
  for (const paths of [[], [["可靠性"], ["工具使用"]], [["指令遵循", "遗漏"]]]) {
    draft.new_classes[0]!.category_paths = paths;
    assert.throws(() => clusteringProfile.resolve!(bound, draft, audit), ValidationError);
  }
  draft.new_classes[0]!.category_paths = [["计算与逻辑错误"]];
  const resolved = clusteringProfile.resolve!(bound, draft, audit);
  clusteringProfile.validate!(bound, resolved, audit);
  draft.class_updates = [{ class_id: "C1", category_paths: [], reason: "清空主要主题。" }];
  assert.throws(() => clusteringProfile.resolve!(bound, draft, audit), ValidationError);
  delete draft.class_updates[0]!.category_paths;
  draft.class_updates[0]!.definition = "明确计算偏差的范围。";
  clusteringProfile.validate!(bound, clusteringProfile.resolve!(bound, draft, audit), audit);
});

test("directory consolidation organizes every retained class without changing responsibility", () => {
  const bound = request(), input = requestInput(bound), draft = result();
  input.budget.consolidate = true;
  assert.throws(() => clusteringProfile.validate!(bound, draft, audit), /每个保留类/);
  draft.class_updates = [{ class_id: "class-arithmetic", category_paths: [["计算与逻辑错误"]], reason: "按错误动作整理方向。" }];
  clusteringProfile.validate!(bound, draft, audit);
  assert.equal(input.library.components[0]!.label, "模型自身推理");
});

test("persistent definitions reject current directory references but preserve business codes", () => {
  const bound = request(), draft = result();
  const component = requestInput(bound).library.components[0]!;
  for (let index = 2; index <= 19; index++) component.classes.push({ id: `class-${index}`, label: `其他现象${index}`, definition: "d", aliases: [], occurrences: 1, examples: [] });
  draft.new_classes[0]!.definition = "型号 C18 与 C1 不同，错误码（C18）等问题应保留业务含义，证券代码（C1）与牌号 (C19) 也不是类编号。";
  clusteringProfile.validate!(bound, draft, audit);
  for (const definition of ["不同于问题类 C18 的另一种问题。", "并非某种现象（C1）等问题。", "item_id: O2 的问题。",
    "日期、期间及项目阶段错置归C19。", "可复算的数值冲突归C1。", "不包括金融分析框架缺项（C5）。"]) {
    draft.new_classes[0]!.definition = definition;
    assert.throws(() => clusteringProfile.validate!(bound, draft, audit), /临时编号/);
  }
});

test("merging topics requires an explicit choice when the union exceeds the limit", () => {
  const bound = request(), draft = result(), component = requestInput(bound).library.components[0]!;
  component.classes[0]!.category_paths = [["一"]];
  component.classes.push({ id: "other-class", label: "近义计算错", definition: "d", aliases: [], occurrences: 1, examples: [], category_paths: [["二"]] });
  draft.merges = [{ into: "class-arithmetic", from: ["other-class"], reason: "同一现象。" }];
  assert.throws(() => clusteringProfile.validate!(bound, draft, audit), /只能保留一条/);
  draft.class_updates = [{ class_id: "class-arithmetic", category_paths: [["计算与逻辑错误"]], reason: "合并后统一主题。" }];
  clusteringProfile.validate!(bound, draft, audit);
  draft.class_updates.push({ class_id: "other-class", definition: "d", reason: "同时维护被合并类。" });
  assert.throws(() => clusteringProfile.validate!(bound, draft, audit), /不能同时维护 from/);
});

for (const paths of [undefined, []] as (string[][] | undefined)[]) test(`an accepted merge preserves ${paths ? "empty" : "omitted"} inherited topic paths`, () => {
  const bound = request(), input = requestInput(bound), component = input.library.components[0]!;
  component.classes = [component.classes[0]!, { ...component.classes[0]!, id: "other-class", label: "近义计算错" }];
  for (const problem of component.classes) {
    if (paths === undefined) delete problem.category_paths;
    else problem.category_paths = structuredClone(paths);
  }
  input.items = []; input.budget.active_classes = 2;
  const registry = new AgentRegistry([clusteringAgent]), binding = { agent: "clustering", profile: "default", request: bound };
  registry.prepare(binding);
  const merged = registry.resolve(binding, { assignments: [], new_classes: [],
    merges: [{ into: "C1", from: ["C2"], reason: "同一计算错误。" }] }, audit) as ClusteringResult;
  registry.validate(binding, merged, audit);
  const library = emptyLibrary(input.model), { classes, ...details } = component;
  library.components[component.id] = { ...details, first_seen: null };
  for (const problem of classes) library.classes[problem.id] = { ...problem, component_id: component.id,
    status: "active", merged_into: null, first_seen: null };
  const receipt = { run_id: "run", evaluator_version: "fixture", task_id: "merge", submission_id: "accepted-merge",
    version: input.model, batch_id: "batch", observations: [], result: merged };
  const original = structuredClone(library), [target, source] = classes;
  const applied = applyClustering(library, receipt);
  assert.equal(applied.classes[source.id]!.merged_into, target.id);
  assert.equal(projectLibrary(applied).components[0]!.classes.length, 1);
  assert.deepEqual(applied.classes[target.id]!.category_paths, paths);
  assert(applied.classes[target.id]!.aliases.includes(source.label));
  assert(applied.events.some(event => event.type === "class_merged"));
  assert.deepEqual(library, original, "applying a receipt does not mutate its input library");
  assert.equal(applyClustering(applied, receipt), applied, "replaying the accepted merge is idempotent");
  assert.throws(() => applyClustering(library, { ...receipt, result: { ...merged,
    class_updates: [{ class_id: target.id, category_paths: [], reason: "清空主题。" }] } }), ValidationError,
    "an explicitly submitted empty path is still rejected");
});

test("Clustering rejects marked category names through public submission validation without sanitizing them", () => {
  const registry = new AgentRegistry([clusteringAgent]);
  const binding = { agent: "clustering", profile: "default", request: request() };
  const draft = submission();
  const marked = "]<]minimax[>[<来源可靠性";
  draft.new_classes[0]!.category_paths = [[marked]];
  draft.class_updates = [{ class_id: "C1", category_paths: [[marked]], reason: "整理主题。" }];
  const before = structuredClone(draft);
  assert.throws(() => registry.resolve(binding, draft, audit), error => {
    assert(error instanceof ValidationError);
    const issues = error.issues!.filter(issue => issue.code === "schema_pattern");
    assert.deepEqual(issues.map(issue => issue.path), ["/new_classes/0/category_paths/0/0", "/class_updates/0/category_paths/0/0"]);
    for (const issue of issues) {
      assert.equal(issue.actual, marked);
      assert.match(String((issue.expected as Record<string, unknown>).category_paths_action), /重新填写/);
    }
    return true;
  });
  assert.deepEqual(draft, before);
});

test("Category character rules cover requests, submissions, results and precise business feedback", () => {
  const registry = new AgentRegistry([clusteringAgent]);
  const binding = { agent: "clustering", profile: "default", request: request() };
  const draft = submission();
  const resolved = registry.resolve(binding, draft, audit) as ClusteringResult;
  const forbidden = ["<", ">", "[", "]", "{", "}",
    ...Array.from({ length: 32 }, (_, code) => String.fromCodePoint(code)),
    ...Array.from({ length: 33 }, (_, code) => String.fromCodePoint(0x7f + code)), "\u2028", "\u2029"];
  for (const character of forbidden) {
    const marked = "主题" + character;
    draft.new_classes[0]!.category_paths = [[marked]];
    const invalidRequest = request();
    requestInput(invalidRequest).library.components[0]!.classes[0]!.category_paths = [[marked]];
    const invalidResult = structuredClone(resolved);
    invalidResult.class_updates = [{ class_id: "class-arithmetic", category_paths: [[marked]], reason: "整理主题。" }];
    for (const [operation, path] of [
      [() => registry.prepare({ ...binding, request: invalidRequest }), "/library/components/0/classes/0/category_paths/0/0"],
      [() => registry.resolve(binding, draft, audit), "/new_classes/0/category_paths/0/0"],
      [() => registry.validate(binding, invalidResult, audit), "/class_updates/0/category_paths/0/0"],
    ] as const) assert.throws(operation, error => {
      assert(error instanceof ValidationError);
      const issue = error.issues!.find(issue => issue.code === "schema_pattern" && issue.path === path);
      assert(issue, JSON.stringify({ character, path }));
      assert.equal(issue.actual, marked);
      return true;
    });
    const paths = [[marked]], before = structuredClone(paths);
    const issue = categoryPathIssues(paths, "/category_paths")[0]!;
    assert.equal(issue.code, "clustering_category_characters");
    assert.equal(issue.path, "/category_paths/0/0");
    assert.equal(issue.actual, marked);
    assert.match(String((issue.expected as Record<string, unknown>).category_paths_action), /重新填写/);
    assert.deepEqual(paths, before);
  }
});

test("Category names allow arbitrary ordinary text without provider word filtering", () => {
  const registry = new AgentRegistry([clusteringAgent]);
  const bound = request();
  const paths = [["minimax 语义 🧭 (输入/输出) — 12"]];
  requestInput(bound).library.components[0]!.classes[0]!.category_paths = structuredClone(paths);
  const binding = { agent: "clustering", profile: "default", request: bound };
  const draft = submission();
  draft.new_classes[0]!.category_paths = structuredClone(paths);
  draft.class_updates = [{ class_id: "C1", category_paths: structuredClone(paths), reason: "整理主题。" }];
  const resolved = registry.resolve(binding, draft, audit) as ClusteringResult;
  registry.validate(binding, resolved, audit);
  assert.deepEqual(resolved.new_classes[0]!.category_paths, paths);
  assert.deepEqual(resolved.class_updates![0]!.category_paths, paths);
  assert.deepEqual(categoryPathIssues(paths, "/category_paths"), []);
});
