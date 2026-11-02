import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { EvaluationAssets } from "./analysis-assets.js";

test("asset discovery reads a named task batch without exposing its provenance", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "named-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pair = "fast_a_vs_fast_b", assetId = `comparison/${pair}/${pair}-search_eval.jsonl`;
  await mkdir(path.join(root, "comparison", pair), { recursive: true });
  await writeFile(path.join(root, assetId), '{"case":{"batch_id":"search_eval"}}\n');
  await mkdir(path.join(root, ".delivery/provenance"), { recursive: true });
  await writeFile(path.join(root, ".delivery/provenance/search_eval.jsonl"), '{}\n');
  const assets = new EvaluationAssets([{ id: "search", path: root, test: false }]);
  const listed = await assets.list({});
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].reference.assetId, assetId);
  assert.match((await assets.read(listed.items[0].reference)).text, /search_eval/);
});

test("asset discovery includes archived evaluations and standalone trees without exposing state or debug files", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "analysis-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name: string, text: string) => { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
  await write("0_wencai/eval_output/1_task_eval/.archive/task/run/report.md", "甲😀乙");
  await write("0_wencai/eval_output/1_task_eval/.archive/task/run/results/score.jsonl", '{"score":80}\n');
  await write("1_aime/eval_output/0_daily_eval/cluster/cluster_tree.jsonl", '{"classes":3}\n');
  await write("1_aime/eval_output/test_eval/test/report.md", "测试");
  await write("1_aime/eval_output/0_daily_eval/run/state.json", '{"private":"配置"}');
  await write("1_aime/eval_output/0_daily_eval/run/_internal/report.md", "排查材料");
  await symlink(path.join(root, "1_aime/eval_output/0_daily_eval/run/state.json"), path.join(root, "1_aime/eval_output/0_daily_eval/run/report.md"));
  const assets = new EvaluationAssets([
    { id: "0_wencai/1_task_eval", path: path.join(root, "0_wencai/eval_output/1_task_eval"), test: false },
    { id: "1_aime/0_daily_eval", path: path.join(root, "1_aime/eval_output/0_daily_eval"), test: false },
    { id: "1_aime/test_eval", path: path.join(root, "1_aime/eval_output/test_eval"), test: true },
  ]), directory = await assets.list({});
  assert.equal(directory.complete, true);
  assert.equal(directory.total, 3);
  assert.equal(directory.summary.archivedCount, 2);
  assert.equal((await assets.list({ includeTests: true })).total, 4);
  assert(!JSON.stringify(directory).includes('"file":'), "filesystem locations stay inside the data layer");
  const page = await assets.list({ query: "score", limit: 1 });
  assert.equal(page.total, 1);
  assert.equal(page.summary.assetCount, 1, "summary counts follow the requested filter, independently of paging");
  assert.equal(page.items[0].archived, true);
  assert.equal(page.items[0].reference.collectionId, "0_wencai/1_task_eval");
  const reference = { collectionId: "0_wencai/1_task_eval", assetId: ".archive/task/run/report.md" };
  const first = await assets.read(reference, { limit: 2 });
  assert.equal(first.text, "甲😀");
  assert.equal(first.nextOffset, 2);
  assert.equal((await assets.read(reference, { offset: 2 })).text, "乙");
  for (const assetId of ["../state.json", "run/state.json", "run/report.md", "/etc/passwd"])
    await assert.rejects(assets.read({ collectionId: "1_aime/0_daily_eval", assetId }), /不存在|公开/);
});

test("asset paths reject linked collection directories outside the configured root", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "analysis-assets-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside"), output = path.join(root, "data/0_wencai/eval_output");
  await mkdir(outside, { recursive: true }); await mkdir(output, { recursive: true });
  await writeFile(path.join(outside, "report.md"), "outside");
  await symlink(outside, path.join(output, "0_daily_eval"));
  const assets = new EvaluationAssets([
    { id: "0_wencai/0_daily_eval", path: path.join(output, "0_daily_eval"), test: false },
  ]), list = await assets.list({});
  assert.equal(list.complete, false); assert.equal(list.total, 0);
  assert.match(list.errors[0].message, /软链接/);
  assert.equal((await assets.list({ collectionId: "1_aime/0_daily_eval" })).complete, true);
  await assert.rejects(assets.read({ collectionId: "0_wencai/0_daily_eval", assetId: "report.md" }), /软链接/);
});

test("compressed formal assets retain Unicode coordinates and never use compressed bytes as text length", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "analysis-assets-gzip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const collection = { id: "custom/research", path: path.join(root, "arbitrary/renamed-results"), test: false };
  const folder = path.join(collection.path, "run/results");
  await mkdir(folder, { recursive: true });
  const text = JSON.stringify({ text: "甲😀乙" }) + "\n";
  await writeFile(path.join(folder, "attribution.jsonl.gz"), gzipSync(text));
  const assets = new EvaluationAssets([collection]), reference = (await assets.list({})).items[0].reference;
  assert.equal(reference.collectionId, collection.id);
  const offset = [...text].indexOf("😀"), page = await assets.read(reference, { offset, limit: 1 });
  assert.equal(page.text, "😀");
  assert.equal(page.unit, "unicode_code_points");
  assert.equal(page.nextOffset, offset + 1);
  assert.equal((await assets.read(reference, { offset: page.nextOffset! })).text, [...text].slice(offset + 1).join(""));
  assert.equal(page.total, null, "a partial stream has no known total character count");
  const end = await assets.read(reference, { offset: 1000 });
  assert.equal(end.text, ""); assert.equal(end.total, [...text].length, "an exhausted stream reports actual characters, never compressed bytes");
});
