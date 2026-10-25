import { testSettings } from "../../fixtures/settings.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { loadComparisonConfig } from "@eval/host-app/config";
import { comparisonAgent } from "@eval/agents/comparison";
import { attributionAgent } from "@eval/agents/attribution";
import { evidenceSelectionSchema, SUBMISSION_FILE_SCHEMA, SUBMISSION_JSON_SCHEMA, type JsonSchema } from "@eval/contracts";
import { sharedPromptResources } from "@eval/prompts";
import { builtinTools } from "@eval/tools";
import { dashboardReference } from "../../../apps/host/src/dashboard-reference.js";
import { ROOT } from "../../fixtures/services.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

async function referencePage() {
  const config = await loadComparisonConfig(path.join(ROOT, "configs/host.json"), testSettings("http://127.0.0.1:1/v1"));
  const reference = dashboardReference(config.evaluation, config.evaluatorVersion);
  const dom = new JSDOM(await readFile(path.join(ROOT, "apps/host/dashboard/reference.html"), "utf8"));
  try {
    const source = await readFile(path.join(ROOT, "apps/host/dashboard/reference.js"), "utf8");
    const load = new Function("document", "fetch", "const root = document, options = {};\n" + source.slice(source.indexOf("const $"), source.lastIndexOf("void init();")) + "return init();");
    await load(dom.window.document, async (url: string) => {
      assert(["/api/dashboard/reference", "/api/dashboard/inputs"].includes(url));
      return new Response(JSON.stringify(url.endsWith("/reference") ? reference : { status: "ready", dates: [], issues: 0 }));
    });
    return { dom, document: dom.window.document, reference };
  } catch (error) { dom.window.close(); throw error; }
}

test("reference definitions distinguish source selections, derived comparisons and clustering short references", async () => {
  const page = await referencePage();
  const { document } = page;
  const click = (selector: string) => {
    const node = document.querySelector(selector);
    if (node.tagName === "OPTION") { node.parentElement.value = node.value; node.parentElement.dispatchEvent(new document.defaultView.Event("change", { bubbles:true })); }
    else node.click();
  };
  try {
    click('[data-stage="rewrite"]');
    assert(document.querySelector('[data-document="submission"]'), "model text arrays have a separate submission contract");
    assert.equal(document.querySelector('[data-document="result"]').textContent, "结果 Schema");
    click('[data-document="result"]');
    assert.equal(document.querySelector(".definition-source").textContent, "schemas/rewrite/result.schema.json");
    click('[data-stage="criteria"]');
    assert.equal(document.querySelector('[data-document="result"]').textContent, "结果 Schema");
    click('[data-document="submission"]');
    assert.equal(document.querySelector(".definition-source").textContent, "schemas/criteria/submission.schema.json");
    const criteriaSubmission = JSON.parse(document.querySelector(".schema-json").textContent);
    assert.deepEqual(criteriaSubmission, page.reference.stages.find((stage) => stage.id === "criteria")!.profiles[0].schemas.submission);
    click('[data-stage="comparison"]');
    click('[data-document="submission"]');
    assert.equal(document.querySelector(".definition-source").textContent, "schemas/comparison/submission.schema.json");
    const comparisonSubmission = JSON.parse(document.querySelector(".schema-json").textContent);
    assert.deepEqual(comparisonSubmission, page.reference.stages.find((stage) => stage.id === "comparison")!.profiles[0].schemas.submission);
    click('[data-stage="clustering"]');
    click('[data-document="submission"]');
    assert.equal(document.querySelector(".definition-source").textContent, "schemas/clustering/submission.schema.json");
    const schema = JSON.parse(document.querySelector(".schema-json").textContent);
    assert.deepEqual(schema, page.reference.stages.find((stage) => stage.id === "clustering")!.profiles[0].schemas.submission);
    click('[data-document="submissionNudge"]');
    assert.equal(document.querySelector(".definition-source").textContent, "packages/prompts/resources/shared/nudge.md");
  } finally { page.dom.window.close(); }
});

test("reference storage lists actual result files and keeps rewrites embedded in source rows", async () => {
  const { dom, document, reference } = await referencePage();
  try {
    const section = [...document.querySelectorAll(".reference-section")].find((element: any) => element.querySelector("h2").textContent === "保存位置")!;
    const cells = new Map([...section.querySelectorAll("tbody tr")].map((row: any) => [row.cells[0].textContent, row.cells[1]]));
    assert.deepEqual([...cells.get("对比").querySelectorAll("code")].map((element: any) => element.textContent),
      ["comparison.jsonl", "comparison-review.jsonl", "comparison-verification.jsonl"].map((file) => `${reference.storage.runs}/<run-id>/results/${file}`));
    assert.equal(cells.get("改写").textContent, "源结果的 rewritten 字段");
    assert.equal(cells.get("改写").querySelector("code"), null, "rewrites do not have a separate result file");
    assert.match(document.querySelector("#reference-content").textContent, /全部基础归因完成后/);
    assert.deepEqual(reference.flow.steps.map((step) => [step.id, step.stage, step.profile]),
      [["criteria", "criteria", "default"], ["attribution", "attribution", "default"], ["comparison", "comparison", "default"]]);
    const audit = reference.flow.branches.find((branch) => branch.name === "可选独立复核")!;
    assert.deepEqual(audit.steps.map((step) => [step.stage, step.profile]), [["comparison", "verification"], ["comparison", "verification"]]);
    assert.match(audit.condition, /失败或证据不足不影响原正式裁决/);
    assert.match(audit.steps[1].output!, /不自动开启归因或对比重评/);
    assert.match(reference.flow.branches.find((branch) => branch.name === "问题库维护")!.condition, /不依赖对比裁决/);
    assert.equal(reference.flow.branches.find((branch) => branch.name === "聚类改写")!.enabled, reference.clustering.enabled && reference.rewrite.clustering);
    const proseRewrite = reference.flow.branches.find((branch) => branch.name === "总评与取舍改写")!;
    assert.equal(proseRewrite.enabled, reference.rewrite.comparison && reference.rewrite.comparisonItems === true);
    assert.equal(proseRewrite.steps[0]!.name, "双方整体总评与取舍");
    assert.match(document.querySelector("#reference-content").textContent, /任务内正整数 evidence_index/);
    document.querySelector('[data-open-stage="comparison"][data-open-profile="verification"]').click();
    assert.equal(document.querySelector('[data-profile="verification"]').selected, true);
    assert.equal(document.activeElement, document.querySelector('[data-pick="stage"]'));
  } finally { dom.window.close(); }
});

test("reference profiles expose independent inspection and the current canonical and model submission schemas", async () => {
  const { dom, document, reference } = await referencePage();
  const click = (selector: string) => {
    const node = document.querySelector(selector);
    if (node.tagName === "OPTION") { node.parentElement.value = node.value; node.parentElement.dispatchEvent(new document.defaultView.Event("change", { bubbles:true })); }
    else node.click();
  };
  try {
    const comparison = reference.stages.find((stage) => stage.id === "comparison")!;
    assert.deepEqual(comparison.profiles.map((profile) => profile.id), ["default", "verification"]);
    const primary = comparison.profiles[0], verification = comparison.profiles[1];
    const current = comparisonAgent.profiles.verification;
    assert.deepEqual(verification.schemas.request, current.requestSchema);
    assert.deepEqual(verification.schemas.submission, current.submissionSchema);
    assert.deepEqual(verification.schemas.inspection, current.inspection!.schema);
    assert.deepEqual(verification.schemas.modelInspection, current.inspection!.modelSchema);
    assert.deepEqual(verification.schemas.result, current.resultSchema);
    assert.deepEqual(verification.schemas.modelSubmission, evidenceSelectionSchema(current.submissionSchema));
    assert.deepEqual(primary.schemas.modelSubmission, evidenceSelectionSchema(comparisonAgent.profiles.default.submissionSchema));
    const attribution = reference.stages.find((stage) => stage.id === "attribution")!.profiles[0];
    assert.deepEqual(attribution.schemas.modelSubmission, evidenceSelectionSchema(attributionAgent.profiles.default.submissionSchema));
    assert.equal(attribution.requestBoundSubmission, true);
    assert.equal(primary.requestBoundSubmission, true);
    assert.equal(verification.requestBoundSubmission, false);
    for (const stage of reference.stages) for (const profile of stage.profiles) {
      assert.equal(profile.fileSubmission, stage.id === "comparison" && profile.id === "verification");
      assert.deepEqual(Object.keys(profile.toolSchemas), Object.keys(profile.toolDescriptions));
      for (const [name, schema] of Object.entries(profile.toolSchemas)) {
        assert.deepEqual(schema, name === "submit_evaluation_file" || name === "inspect_material" && profile.fileSubmission ? SUBMISSION_FILE_SCHEMA
          : name === "submit_evaluation" ? profile.jsonStringSubmission ? SUBMISSION_JSON_SCHEMA : profile.schemas.modelSubmission ?? profile.schemas.submission ?? profile.schemas.result
          : name === "inspect_material" ? profile.schemas.modelInspection : builtinTools.find((tool) => tool.name === name)!.inputSchema);
        assert(profile.sources.toolSchemas.includes("packages/prompts/resources/tools/" + name + ".md"));
      }
      for (const sources of Object.values(profile.sources)) for (const source of sources)
        assert((await readFile(path.join(ROOT, source), "utf8")).trim(), "reference source exists: " + source);
    }
    click('[data-stage="comparison"]');
    click('[data-profile="verification"]');
    for (const key of ["modelInspection", "inspection", "submission", "modelSubmission"] as const) {
      click('[data-document="' + key + '"]');
      assert.deepEqual(JSON.parse(document.querySelector(".schema-json").textContent), verification.schemas[key]);
      assert.deepEqual([...document.querySelectorAll(".definition-source code")].map((element: any) => element.textContent), verification.sources[key]);
    }
    for (const key of ["system", "instructions"] as const) {
      click('[data-document="' + key + '"]');
      assert.equal(document.querySelector(".prompt-text").textContent, verification.prompts[key]);
      assert.equal(document.querySelector(".definition-source").textContent, "packages/prompts/resources/comparison/verification/" + key + ".md");
    }
    click('[data-document="tools"]');
    const names = [...document.querySelectorAll(".tool-definitions dt")].map((element: any) => element.textContent);
    assert.deepEqual(names, Object.keys(current.toolDescriptions));
    assert(names.includes("inspect_material"));
    const tools = [...document.querySelectorAll(".tool-definitions > div")];
    const inspectionTool = tools.find((element: any) => element.querySelector("dt").textContent === "inspect_material")!;
    assert.deepEqual(JSON.parse(inspectionTool.querySelector(".schema-json").textContent), SUBMISSION_FILE_SCHEMA);
    click('[data-stage="exports"]');
    click('[data-document="comparison"]');
    assert.deepEqual([...document.querySelectorAll(".definition-source code")].map((element: any) => element.textContent), reference.exportSources.comparison);
    const output = JSON.parse(document.querySelector(".schema-json").textContent);
    assert.deepEqual(output, reference.exports.comparison);
    assert(((output.$defs as Record<string, any>).evaluation.properties.findings.items.properties as Record<string, JsonSchema>).stage_trace);
  } finally { dom.window.close(); }
});

test("reference shared prompts retain live text and definitions remain directly visible", async () => {
  const { dom, document, reference } = await referencePage();
  const click = (selector: string) => {
    const node = document.querySelector(selector);
    if (node.tagName === "OPTION") { node.parentElement.value = node.value; node.parentElement.dispatchEvent(new document.defaultView.Event("change", { bubbles:true })); }
    else node.click();
  };
  try {
    assert.deepEqual(reference.sharedPrompts, Object.fromEntries(sharedPromptResources().map(({ name, text, source }) => [name, { text, source }])));
    assert.deepEqual(Object.keys(reference.sharedPrompts), ["material", "commentary", "evidence", "taskFocus", "budget", "recovery", "nudge"]);
    click('[data-stage="shared"]');
    for (const [key, resource] of Object.entries(reference.sharedPrompts)) {
      click('[data-document="' + key + '"]');
      assert.equal(document.querySelector(".prompt-text").textContent, resource.text);
      assert.equal(document.querySelector(".definition-source").textContent, resource.source);
      assert.equal(resource.text, (await readFile(path.join(ROOT, resource.source), "utf8")).trim());
    }
    click('[data-stage="comparison"]');
    click('[data-profile="verification"]');
    click('[data-document="inspection"]');
    click('[data-document="system"]');
    click('[data-document="inspection"]');
    assert.equal(document.querySelector(".reference-disclosure").tagName, "SECTION");
    click('[data-profile="default"]');
    assert.equal(document.querySelector('[data-profile="default"]').selected, true);
    assert.equal(document.querySelector('[data-document="inspection"]'), null);
    click('[data-profile="verification"]');
    click('[data-document="inspection"]');
    assert.equal(document.querySelector(".reference-disclosure").tagName, "SECTION");
  } finally { dom.window.close(); }
});
