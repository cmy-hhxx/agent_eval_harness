import test from "node:test";
import assert from "node:assert/strict";
import { processComponents, actorCatalog } from "./components.js";
import { attributionSessionSource } from "./public-trace.js";
import { parseEvidenceCoordinates, evidenceSources, cite } from "@eval/tools";

test("component directory preserves named models and actual tools across flattened turns", () => {
  const turns = [0, 1].map(() => ({ messages: [
    { type: "llm_turn", name: "llm-call-7", model: "AIME-Atlas", parent_span: "parent", system_prompt: "PRIVATE_SENTINEL", output: [] },
    { type: "tool_call", name: "shell", call_id: "same", parent_span: "parent", input: { command: "python /work/render.py" } },
    { type: "tool_result", name: "shell", tool_call_id: "same", output: "done" },
  ] }));
  const id = "11111111-1111-4111-8111-111111111111";
  const source = attributionSessionSource({ messages: [], turns });
  const directory = processComponents(source.raw, source.original, id, source.positions);
  assert.deepEqual(directory.map(entry => [entry.component_index, entry.name, entry.kind]), [[1, "llm-call-7", "model"], [2, "shell", "tool"], [3, "/work/render.py", "script"]]);
  assert.deepEqual(directory[1]!.positions.map(position => position.trace_index), [0, 0, 1, 1]);
  assert.deepEqual(directory[1]!.invoked_by, [1]);
  assert(!JSON.stringify(directory).includes("PRIVATE_SENTINEL"));
  assert(!JSON.stringify(directory).includes("限制披露"));
  const before = structuredClone(directory), view = actorCatalog(directory);
  assert.deepEqual(view.map(entry => [entry.actor_index, entry.kind, entry.name]), [[1, "model", "llm-call-7"], [2, "tool", "shell"], [3, "script", "/work/render.py"]]);
  assert.deepEqual(Object.keys(view[1]!).sort(), ["actor_index", "invoked_by", "kind", "message_indices", "name", "source_evidence"]);
  assert.deepEqual(view[1]!.source_evidence, directory[1]!.source_evidence);
  assert.deepEqual(directory, before);
  for (const component of directory) for (const proof of component.source_evidence as {reference:{evidence_id:string}}[])
    assert.equal(parseEvidenceCoordinates(proof.reference.evidence_id)?.input_id, id);
});

test("a source-identified inner service remains distinct from its shell transport", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const raw = { messages: [
    { type: "llm_turn", model: "AIME-Atlas", parent_span: "parent", output: [] },
    { type: "tool_call", name: "shell", call_id: "request", parent_span: "parent", input: { command: "finquery --request" } },
    { type: "tool_result", name: "shell", tool_call_id: "request", output: { tool: "finquery", status_code: -3222 } },
  ] };
  const positions = raw.messages.map((_, message_index) => ({ trace_index: 0, message_index }));
  const source = evidenceSources(raw.messages[2]).find(source => source.path === "/output/tool")!;
  const original = cite(id, 2, source, 0, source.text.length);
  const evidence = { evidence_id: original.evidence_id, quote: original.quote };
  const identity = (index: number, path: string) => {
    const source = evidenceSources(raw.messages[index]).find(source => source.path === path)!;
    const { evidence_id, quote } = cite(id, index, source, 0, source.text.length); return { evidence_id, quote };
  };
  const components = processComponents(raw, raw, id, positions, [
    { components_kind: "model", components_name: "规划", components_content: "为取得财务数据生成查询；已交给shell执行。", evidence: [identity(0, "/model")] },
    { components_kind: "tool", components_name: "shell", components_content: "为运行查询脚本执行命令；返回服务状态。", evidence: [identity(1, "/name")] },
    { components_kind: "tool", components_name: "finquery", components_content: "内层取数服务。", evidence: [evidence] },
  ]);
  assert.deepEqual(components.map(component => component.name), ["规划", "shell", "finquery"]);
  assert.deepEqual(components[2]!.invoked_by, [1]);
  assert.deepEqual(components[2]!.source_evidence, [{ reference: { evidence_id: evidence.evidence_id }, quote: evidence.quote, message_index: 2 }]);
  assert.equal(components[2]!.identity_basis, "source_reference");
  assert.equal(components[0]!.identity_basis, "source_reference");
  assert.equal(components[2]!.component_index, 3);
  assert.equal(components[0]!.positions.length, 1);
});

test("component descriptions replace locator names while retaining source identity and responsibility links", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const raw = { messages: [
    { type: "llm_turn", name: "llm-call-7", parent_span: "plan", output: "为回答本期营收，先查询本期财务数据。" },
    { type: "tool_call", name: "finquery", call_id: "query", parent_span: "plan", input: { query: "本期营收" } },
    { type: "tool_result", name: "finquery", tool_call_id: "query", output: "本期营收100亿元。" },
  ] };
  const positions = raw.messages.map((_, message_index) => ({ trace_index: 0, message_index }));
  const evidence = (index: number, path: string) => {
    const source = evidenceSources(raw.messages[index]).find(source => source.path === path)!;
    const { evidence_id, quote } = cite(id, index, source, 0, source.text.length);
    return { evidence_id, quote };
  };
  const extracted = [
    { components_kind: "model", components_name: "规划", components_content: "为回答本期营收，生成本期财务查询请求；请求已交给 finquery 执行。",
      evidence: [evidence(0, "/name"), evidence(0, "/output")] },
    { components_kind: "tool", components_name: "finquery", components_content: "为取得本期营收，执行财务查询；返回100亿元。",
      evidence: [evidence(1, "/name"), evidence(2, "/output")] },
  ];
  const directory = processComponents(raw, raw, id, positions, extracted);
  assert.deepEqual(directory.map(entry => entry.name), ["规划", "finquery"]);
  assert.deepEqual(directory.map(entry => entry.components_content), extracted.map(entry => entry.components_content));
  assert.deepEqual(directory[1]!.invoked_by, [1]);
  assert.equal((actorCatalog(directory)[0] as Record<string, unknown>).content, extracted[0]!.components_content);
});

test("actual script invocations and skill reads become source actors while inline code and file mentions do not", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const command = 'cat > /work/notes <<\'EOF\'\n🧪 saved text\npython /work/not-executed.py\ncat fake/ROUTE.md\nEOF\necho "example; python /work/not-executed-either.py && cat phantom/ROUTE.md"\n# node /work/comment.js; python comment.py\ncd /work && python "/work/render.py"\nnode routes/chart/workflow.js\npython scripts/calc.py --code-file /work/calc1.py\ncat routes/chart/ROUTE.md\npython -c "print(\'mention.py\')"\npython -m package\ncat data.json';
  const raw = { messages: [
    { type: "llm_turn", name: "llm-call-0", parent_span: "plan", output: [{ tool_calls: [{ id: "run", function: { name: "shell", arguments: JSON.stringify({ command }) } }] }] },
    { type: "tool_call", name: "shell", call_id: "run", parent_span: "plan", input: {
      command,
    } },
    { type: "tool_call", name: "view_skill", input: { name: "pdf" } },
  ] };
  const positions = raw.messages.map((_, message_index) => ({ trace_index: 0, message_index }));
  const directory = processComponents(raw, raw, id, positions);
  assert.deepEqual(directory.filter(actor => actor.kind === "script").map(actor => actor.name), ["/work/render.py", "routes/chart/workflow.js", "scripts/calc.py", "/work/calc1.py"]);
  assert.deepEqual(directory.filter(actor => actor.kind === "skill").map(actor => actor.name), ["routes/chart/ROUTE.md", "pdf"]);
  for (const script of directory.filter(actor => actor.kind === "script")) {
    assert.deepEqual(script.invoked_by, [1]);
    assert.equal(script.source_evidence[0]!.quote, script.name);
    const point = parseEvidenceCoordinates((script.source_evidence[0]!.reference as {evidence_id:string}).evidence_id);
    assert(point && point.kind !== "image");
    assert.equal(point.path, "/input/command");
  }
});

test("executed Python scripts include visible local imports, without listing merely written modules", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const commands = [
    "cat > /work/layout.py <<'PY'\nROW=10\nPY",
    "cat > /work/unused.py <<'PY'\nVALUE=1\nPY",
    "cat > /work/make.py <<'PY'\nfrom layout import *\nimport openpyxl\nPY\ncd /work && python make.py",
    'cd /work && python -c "from layout import *; print(ROW)"',
  ];
  const raw = { messages: commands.map(command => ({ type: "tool_call", name: "shell", input: { command } })) };
  const positions = raw.messages.map((_, message_index) => ({ trace_index: 0, message_index }));
  const scripts = processComponents(raw, raw, id, positions).filter(actor => actor.kind === "script");
  assert.deepEqual(scripts.map(actor => actor.name), ["make.py", "/work/layout.py"]);
  assert(scripts[1]!.source_evidence.some(proof => proof.quote === "/work/layout.py"));
  assert(scripts[1]!.source_evidence.some(proof => proof.quote === "from layout import *"));
  assert(scripts[1]!.positions.some(point => point.source_message_index === 2));
});
