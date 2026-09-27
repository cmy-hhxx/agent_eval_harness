# 评测 Schema

这里是仓库中评测 Schema 的唯一集中目录。Agent 只需先看本页，再按阶段打开对应文件；原始评测输入由 `a` / `aa` 适配器接入，不维护覆盖所有来源格式的总 Schema。

| 目录 | 内容 |
|---|---|
| `attribution/` | 单条回答归因阶段的请求、模型提交和 Host 接受结果 |
| `comparison/` | 对比阶段的请求和结果；该阶段不解析证据，因此提交与结果共用 `result.schema.json` |
| `rewrite/` | 改写阶段的请求和结果；只交换文本槽位、不解析证据，因此提交与结果共用 `result.schema.json` |
| `clustering/` | 聚类阶段的请求和结果；只归类问题观察、不解析证据，因此提交与结果共用 `result.schema.json` |
| `workflow/` | Workflow 组合后的正式导出、回溯标注、改写与聚类产物 Schema |

## 文件含义

- `request.schema.json`：Host 组装给 Agent 的内部请求护栏，不是原始数据源契约。
- `submission.schema.json`：模型通过提交工具返回的 JSON；有证据的阶段使用 `evidence_id`。归因提交不重复写请求中已确定的 `has_standard_answer`。
- `result.schema.json`：Host 解析并接受后的阶段结果；有证据的阶段使用 `message_index` 和 `quote`。归因结果由 Host 加入 `has_standard_answer`。
- `workflow/export.schema.json`：加入身份、模型信息、归因评语、回溯标注和派生判决后的正式对比行。
- `workflow/commentary.schema.json`：改写阶段接受后的评语产物行，用源任务和结果 id 指向正式结果。
- `workflow/clustering.schema.json`：聚类阶段接受后的归类产物行，按模型与批次引用观察和归类决定。Comparison、Rewrite 与 Clustering 不解析证据，因此没有单独的 `submission.schema.json`，提交与结果共用 `result.schema.json`。

修改顺序：Schema → 对应 Profile 的 `index.ts` → `validate.ts` /（如有）`resolve.ts` → [集中提示词](../packages/prompts/README.md)、测试样例和测试。不要为旧 Schema 保留别名或兼容入口；项目哈希、摘要和跨 run 结果缓存规则见[开发指南](../docs/development.md#禁止项目哈希与兼容层)。
