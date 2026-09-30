# Schema

这里是仓库中评测及分析助手 Schema 的唯一集中目录。先看本页，再按任务打开对应文件；原始评测输入由 `a` / `b` 适配器接入，不维护覆盖所有来源格式的总 Schema。

| 目录 | 内容 |
|---|---|
| `attribution/` | 单条回答归因阶段的请求、模型提交和 Host 接受结果 |
| `comparison/` | 对比阶段的请求和结果；提交 Schema 从结果 Schema 去掉 `rewritten` 后派生 |
| `rewrite/` | 改写阶段的请求和结果；只交换文本槽位、不解析证据，因此提交与结果共用 `result.schema.json` |
| `clustering/` | 聚类阶段的请求、短编号提交和持久化身份结果；submission/result 分离 |
| `workflow/` | Workflow 组合后的正式导出、回溯标注与聚类产物 Schema |
| `eris/` | 独立分析助手的数据读取、专业任务及总结工具输入 |

## 文件含义

- `request.schema.json`：Host 组装给 Agent 的内部请求护栏，不是原始数据源契约。
- `submission.schema.json`：模型通过提交工具返回的 JSON；有证据的阶段使用 `evidence_id`。归因提交不重复写请求中已确定的 `has_standard_answer`。
- `result.schema.json`：Host 解析并接受后的阶段结果；有证据的阶段使用 `message_index` 和 `quote`。归因结果由 Host 加入 `has_standard_answer`。
- `workflow/export.schema.json`：加入身份、模型信息、归因评语、回溯标注和派生判决后的正式对比行。
- `workflow/statistics-log.schema.json`：已冻结的统计日志外部契约，覆盖完整日志信封、累计总计、逐日统计和全部嵌套字段；所有 `wins` 同级紧随必填非负整数 `both_good / both_bad`，涵盖模型、场景、难度及趋势。生成日志落盘前与恢复日志上传前严格校验。仅允许数值、标签内容和日期条目更新，未经用户明确授权不得修改结构。
- `attribution/result.schema.json`、`comparison/result.schema.json`、`clustering/result.schema.json`：各自包含可选 `rewritten` 槽位，原字段不变；Workflow 在改写成功后写回。
- `workflow/clustering.schema.json`：聚类阶段接受后的归类产物行，按模型与批次引用观察和归类决定。
- `eris/tools.json`：独立分析助手的数据读取、专业任务及总结工具输入，不接受自行填写的专业判词。

Comparison 的提交 Schema 由 Agent 公开入口从结果 Schema 去掉 `rewritten` 后派生；Clustering 用独立的 `submission.schema.json` 接收请求内短编号，解析后按 `result.schema.json` 保存真实身份；Rewrite 的提交与结果共用 `result.schema.json`。

专业评测 Schema 修改顺序：Schema → 对应 Profile 的 `index.ts` → `validate.ts` /（如有）`resolve.ts` → [集中提示词](../packages/prompts/README.md)、测试样例和测试。分析助手工具输入改动同步 `agent/src/core/tools.ts`、提示词与测试。不要为旧 Schema 保留别名或兼容入口；项目哈希、摘要和跨 run 结果缓存规则见[开发指南](../docs/development.md#禁止项目哈希与兼容层)。
