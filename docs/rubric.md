# Rubric 评测

[返回首页](../README.md) · [模块地图](modules/README.md) · [运行与恢复](usage.md#运行与恢复)

Rubric 是独立 workflow。一条 trace 的 checklist 为[正式标准](../rubric/overseas-expert-v1.json)的通用 30 条，加该 trace 所属 L2 的全部专项条目。每条输出 `pass / partial / fail / na`，遵循条目自身允许的状态；只汇总计数，不加权、不合成总分。

## 材料边界

- 通用条目先读取对应 trace 的完整归因结论、问题详情及证据，必要时定向读取原始会话。未发现归因问题不等于所有通用条目通过。
- 专项条目仅接收用户题面、用户明确提供的背景和本轮最终回答。工具也只能读取这些消息，不能访问归因、内部过程或工具返回。
- 两类条目分批执行，默认每批最多 10 条；保留 checklist 全局编号。所有批次通过校验后，程序按 trace 合并，再按 case 写出。
- 非 `na` 判定须引用本次工具提供的原文证据编号，Host 重算引用；材料不足或不适用时写 `na_reason`。

缺失归因先用现有 `workflow: "attribution"` 补齐。Rubric 不自动启动其他阶段，也不重写已有归因。

## 配置与运行

覆盖配置示例（模型与输入版本按实际情况填写）：

```json
{
  "workflow": "rubric",
  "rubric": {
    "standard": "/absolute/path/overseas-expert-v1.json",
    "labels": {"mode": "inline", "paths": ["traces[].meta.subtask"]},
    "attribution": "/absolute/path/model_attribution-batch.jsonl",
    "batchSize": 10
  },
  "bindings": {"rubric": {"profile": "judge", "thinking": "low"}},
  "output": {
    "kind": "directory",
    "layout": "business",
    "path": "/absolute/path/output",
    "testPath": "/absolute/path/test-output"
  }
}
```

标签由输入提供，判官不分类。每条 trace 的 `meta.task/subtask` 必须对应标准的 L1/L2 名称或 ID，归因中同 trace 的标签也必须一致。外置标签文件模式还须与输入标签一致；缺失、冲突、重复归因或缺 trace 会阻止派发，不静默跳过。配置里的文件路径相对声明它们的配置文件解析。

真实评测仅在服务器运行：

```bash
node dist/apps/host/src/cli.js preflight --config configs/host.json --config /absolute/path/models.json --config /absolute/path/rubric.json
node dist/apps/host/src/cli.js run --config configs/host.json --config /absolute/path/models.json --config /absolute/path/rubric.json --run-id rubric-batch
```

先使用独立测试输出配置和 `--limit-cases 2` 验证，再运行正式范围。测试与正式任务使用不同 run ID。同 run 续跑保留原任务范围和已接受批次，修改 limit 不扩展原计划。

## 结果与续跑

业务布局逐个发布完成的 case 到 `<output>/rubric.jsonl`。一行含 case、模型、业务批次、评测器标识、源 session/trace 元数据，以及 `result.traces[]`。每条 trace 显式输出 L1/L2 的 ID 与名称、完整 checklist 判定和状态计数；内部恢复数据位于 `.runs/<run ID>/`。

新 run 按输出中已有的模型＋业务批次＋case 跳过最终结果，缺失项继续。无需旧 run、评测器或模型配置一致；部分批次不算完成。共享业务锁防止同批次同模型同时写入，读取/写出失败会报告错误，不把交付失败记为成功。显式 `output.layout: "run"` 时只在 run 的 `results/rubric.jsonl` 交付。

实现：[Workflow](../packages/workflows/src/rubric/index.ts)、[Agent](../packages/agents/src/rubric/index.ts)、[Schema](../schemas/rubric/)、[提示词](../packages/prompts/resources/rubric/default/instructions.md)。
