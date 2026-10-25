import test from "node:test";
import assert from "node:assert/strict";
import { createEris } from "@eval/assistant";

test("assets have direct reads and continuation coordinates and can serve as chart sources", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
  const reference = { collectionId: "1_aime/0_daily_eval", assetId: "cluster/cluster_tree.jsonl" }, reads: unknown[] = [];
  const eris = createEris({ data: { list: unexpected, read: unexpected, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected },
    assets: { async list() { return { kind: "assets", total: 1, items: [{ reference }] }; }, async read(ref, options) {
      reads.push({ ref, options });
      return { kind: "asset", reference, name: "cluster_tree.jsonl", text: "内容", hasMore: true, nextOffset: 20, modifiedAt: 1 };
    } } });
  const context = { scope: { userId: "alice", sessionId: "session" }, callId: "asset", signal: new AbortController().signal, progress() {}, complete: unexpected };
  const read = eris.tools.find(tool => tool.name === "read_asset")!;
  const args = { reference, offset: 10, limit: 10 };
  const result = await read.execute(args, context), output = JSON.parse(result.content[0].text!);
  assert.deepEqual(result.details, { sourceRead: { tool: "read_asset", args } });
  assert.deepEqual(output.nextRead, { tool: "read_asset", args: { ...args, offset: 20 } });
  assert.deepEqual(reads, [{ ref: reference, options: args }]);
  assert.throws(() => read.validate!({ reference: { ...reference, runId: "invented" } }));
  const chart = await eris.tools.find(tool => tool.name === "show_chart")!.execute({ type: "bar", title: "问题分布", scope: "本次问题树",
    categories: ["事实", "工具"], series: [{ name: "问题数", values: [3, 2] }], unit: "条", references: [{ asset: reference }] }, context);
  assert.equal(JSON.parse(chart.content[0].text!).chart.type, "bar");
  assert.deepEqual(reads[1], { ref: reference, options: { limit: 1 } });
  assert.deepEqual(chart.details, { references: [{ asset: reference, name: "cluster_tree.jsonl", modifiedAt: 1 }] });
});
