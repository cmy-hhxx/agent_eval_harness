import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createEris, type ErisDependencies } from "@eval/assistant";
import { erisPrompt } from "@eval/prompts";

test("Eris's public definition includes every tool resource and validates before invoking dependencies", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const received: unknown[] = [];
  const dependencies: ErisDependencies = {
    data: { list: async (query) => { received.push(query); return { items: [] }; }, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, save: unexpected,
  };
  const eris = createEris(dependencies);
  const resources = new URL("../../packages/prompts/resources/eris/", import.meta.url);
  assert.equal(eris.systemPrompt, readFileSync(new URL("system.md", resources), "utf8").trim());
  assert.equal(eris.recoveryMessage, readFileSync(new URL("recovery.md", resources), "utf8").trim());
  assert.deepEqual(eris.tools.map((tool) => `${tool.name}.md`).sort(), readdirSync(new URL("tools/", resources)).sort());
  for (const tool of eris.tools) assert.equal(tool.description, readFileSync(new URL(`tools/${tool.name}.md`, resources), "utf8").trim());
  const list = eris.tools.find((tool) => tool.name === "list_data")!;
  const context = { scope: { userId: "alice", sessionId: "session" }, callId: "list", signal: new AbortController().signal, progress() {} };
  await assert.rejects(list.execute({ limit: 0 }, context));
  assert.deepEqual(received, []);
  const listed = await list.execute({ limit: 5 }, context);
  assert.equal(listed.details, undefined, "business JSON is stored only once");
  const read = eris.tools.find(tool => tool.name === "read_data")!;
  await assert.rejects(read.execute({ reference: { runId: "run", inputId: "input", taskId: "task" } }, context), /oneOf/);
  await assert.rejects(read.execute({ reference: { runId: "run" } }, context), /required/);
  await assert.rejects(read.execute({ reference: { runId: "run", inputId: "input" }, limit: 101 }, context), /100/);
  await assert.rejects(read.execute({ reference: { runId: "run", taskId: "task" }, offset: 0 }, context), /NOT be valid/);
  const image = eris.tools.find(tool => tool.name === "view_image")!;
  await assert.rejects(image.execute({ reference: { runId: "run", inputId: "input" } }, context), /messageIndex/);
  const specialist = eris.tools.find(tool => tool.name === "call_specialist")!;
  const request = { operationId: "6a1b4a17-1039-4ead-ac32-9a37b0bf4ada", kind: "attribution", inputs: [{ runId: "run", inputId: "input" }] };
  await assert.rejects(specialist.execute({ ...request, inputs: [{ runId: "run" }] }, context), /inputId/);
  await assert.rejects(specialist.execute({ ...request, inputs: [{ runId: "run", inputId: "input", taskId: "task" }] }, context), /additional properties/);
  await assert.rejects(specialist.execute({ ...request, attributions: [{ inputId: "input", operationId: request.operationId, runId: "run", taskId: "task" }] }, context), /oneOf/);
  const summary = eris.tools.find(tool => tool.name === "save_summary")!;
  await assert.rejects(summary.execute({ markdown: "summary", references: [{ reference: { runId: "run", inputId: "input" } }] }, context), /additional properties/);
  await assert.rejects(summary.execute({ markdown: "summary", references: [{ reference: { runId: "run", taskId: "task" }, operationId: request.operationId }] }, context), /oneOf/);
  assert.deepEqual(received, [{ limit: 5 }]);
  assert.throws(() => erisPrompt(["list_data", "list_data"]), /Duplicate prompt tool/);
  assert.throws(() => erisPrompt(["unknown_tool"]), /ENOENT/);
});

test("summaries keep verified source locators in metadata instead of the delivered Markdown", async () => {
  const operationId = "6a1b4a17-1039-4ead-ac32-9a37b0bf4ada";
  const reference = { runId: "evaluation-internal", taskId: "comparison-internal" };
  const saved: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const eris = createEris({
    data: {
      list: unexpected, search: unexpected, image: unexpected,
      read: async (ref) => ref.taskId === reference.taskId ? { result: { conclusion: "模型 A 回答正确。" }, evaluatorVersion: "fixture" } : {},
    },
    specialists: {
      invoke: unexpected,
      read: async (_, id) => ({ operationId: id, kind: "comparison", state: id === operationId ? "succeeded" : "running", evaluatorVersion: "fixture", reference }),
    },
    save: async (_, markdown) => { saved.push(markdown); return { name: "summary.md", url: "/summary.md" }; },
  });
  const summary = eris.tools.find(tool => tool.name === "save_summary")!;
  const context = { scope: { userId: "alice", sessionId: "session" }, callId: "summary", signal: new AbortController().signal, progress() {} };
  const markdown = "模型 A 回答正确。\n\n依据：回答给出了可核对的计算过程。";
  const result = await summary.execute({ markdown, references: [{ operationId }, { reference }] }, context);
  assert.deepEqual(saved, [markdown]);
  assert.deepEqual(result.details, { references: [
    { operationId, evaluatorVersion: "fixture", reference },
    { reference, evaluatorVersion: "fixture" },
  ] });
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ name: "summary.md", url: "/summary.md" }) }]);
  await assert.rejects(summary.execute({ markdown, references: [{ operationId: "51b9dc2a-1292-4c4c-a71d-2db0b3f64d96" }] }, context), /已接受/);
  await assert.rejects(summary.execute({ markdown, references: [{ operationId }, { reference: { ...reference, taskId: "missing" } }] }, context), /正式结果不存在/);
  assert.deepEqual(saved, [markdown], "every reference is verified before writing an artifact");
});
