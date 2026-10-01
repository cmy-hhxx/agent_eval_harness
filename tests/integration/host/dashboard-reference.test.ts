import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { loadConfig } from "@eval/host-app/config";
import { dashboardReference } from "../../../apps/host/src/dashboard-reference.js";
import { ROOT } from "../../fixtures/services.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

async function referencePage() {
  const config = await loadConfig(path.join(ROOT, "configs/host.json"), { EVAL_BASE_URL: "http://127.0.0.1:1/v1" });
  const reference = dashboardReference(config.evaluation, config.evaluatorVersion);
  const dom = new JSDOM(await readFile(path.join(ROOT, "apps/host/dashboard/reference.html"), "utf8"));
  try {
    const source = await readFile(path.join(ROOT, "apps/host/dashboard/reference.js"), "utf8");
    const load = new Function("document", "fetch", source.slice(0, source.lastIndexOf("void init();")) + "return init();");
    await load(dom.window.document, async (url: string) => {
      assert(["/api/dashboard/reference", "/api/dashboard/inputs"].includes(url));
      return new Response(JSON.stringify(url.endsWith("/reference") ? reference : { status: "ready", dates: [], issues: 0 }));
    });
    return { dom, document: dom.window.document, reference };
  } catch (error) { dom.window.close(); throw error; }
}

test("reference definitions distinguish derived Comparison submissions from Clustering short-reference schemas", async () => {
  const page = await referencePage();
  const { document } = page;
  const click = (selector: string) => document.querySelector(selector).click();
  try {
    click('[data-section="contracts"]');
    for (const stage of ["criteria", "rewrite"]) {
      click(`[data-stage="${stage}"]`);
      assert.equal(document.querySelector('[data-document="submission"]'), null, "shared schemas have only one output tab");
      assert.equal(document.querySelector('[data-document="result"]').textContent, "提交 / 结果 Schema");
      assert.equal(document.querySelector(".definition-source").textContent, `schemas/${stage}/result.schema.json`);
    }
    click('[data-stage="comparison"]');
    click('[data-document="submission"]');
    assert.equal(document.querySelector(".definition-source").textContent,
      "schemas/comparison/result.schema.json（去掉 rewritten/task_analysis 字段后派生）");
    click('[data-stage="clustering"]');
    click('[data-document="submission"]');
    assert.equal(document.querySelector(".definition-source").textContent, "schemas/clustering/submission.schema.json");
    const schema = JSON.parse(document.querySelector(".schema-json").textContent);
    assert.deepEqual(schema, page.reference.stages.find((stage) => stage.id === "clustering")!.schemas.submission);
    click('[data-document="submissionNudge"]');
    assert.equal(document.querySelector(".definition-source").textContent, "packages/prompts/resources/shared/nudge.md");
  } finally { page.dom.window.close(); }
});

test("reference storage lists actual result files and keeps rewrites embedded in source rows", async () => {
  const { dom, document, reference } = await referencePage();
  try {
    assert.match(document.querySelector(".rule-list").textContent, /缺失或冲突只跳过受影响的模型对/);
    document.querySelector('[data-section="flow"]').click();
    const section = [...document.querySelectorAll(".reference-section")].find((element: any) => element.querySelector("h2").textContent === "保存位置")!;
    const cells = new Map([...section.querySelectorAll("tbody tr")].map((row: any) => [row.cells[0].textContent, row.cells[1]]));
    assert.deepEqual([...cells.get("对比").querySelectorAll("code")].map((element: any) => element.textContent),
      ["comparison.jsonl", "comparison-review.jsonl"].map((file) => `${reference.storage.runs}/<run-id>/results/${file}`));
    assert.equal(cells.get("改写").textContent, "源结果的 rewritten 字段");
    assert.equal(cells.get("改写").querySelector("code"), null, "rewrites do not have a separate result file");
    assert.match(document.querySelector("#reference-content").textContent, /该分片归因与涉及对局裁决完成/);
  } finally { dom.window.close(); }
});
