# 评测 Schema

这里是仓库中评测 Schema 的唯一集中目录。原始评测输入是由 `a` / `aa` 适配器接入的 JSONL，不维护一个覆盖所有来源格式的总 Schema。

| 目录 | 内容 |
|---|---|
| `attribution/` | 单条回答归因阶段的请求、模型提交和 Host 接受结果 |
| `comparison/` | 对比阶段的请求和结果；该阶段不解析证据，因此提交与结果共用 `result.schema.json` |
| `workflow/` | Workflow 组合后的正式导出和回溯标注 Schema |

## 文件含义

- `request.schema.json`：Host 组装给 Agent 的内部请求护栏，不是原始数据源契约。
- `submission.schema.json`：模型通过提交工具返回的 JSON；有证据的阶段使用 `evidence_id`。
- `result.schema.json`：Host 解析并接受后的阶段结果；有证据的阶段使用 `message_index` 和 `quote`。
- `workflow/export.schema.json`：加入身份、模型信息、归因评语、回溯标注和派生判决后的正式对比行。

提示词、业务校验、类型和测试仍按 Agent 保存在 `packages/agents/src/<agent>`；修改 Schema 时同步检查对应 Profile 的 `index.ts`、`validate.ts`、（如有）`resolve.ts`、提示词和样例。
