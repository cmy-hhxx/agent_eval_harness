# Schema

[数据契约](../docs/contract.md) · [模块地图](../docs/modules/README.md)

本目录集中维护评测与 Eris 的 JSON Schema。原始输入由 [A / B 适配器](../packages/workflows/src/inputs/adapters.ts)解析，不属于 Agent 请求 Schema。

| 目录 | 内容 |
|---|---|
| [score/](score/) | 原skill单题0–10总分、12项0–4及24诊断输出 |
| [criteria/](criteria/) | 共同验收基准 |
| [compact/](compact/) | 会话过程摘要；固定浅层字段、程序编号及可解析原文 |
| [attribution/](attribution/) | 独立组件调查、Trace 摘要、跨轮审查与 Session 正式结果 |
| [instruction-review/](instruction-review/) | 后置独立指令遵循归因、证据与核验账本 |
| [comparison/](comparison/) | 普通对比、可选核验及首查检查点 |
| [rewrite/](rewrite/) | 文本槽位改写 |
| [clustering/](clustering/) | 归类、问题库、待观察引用和来源复核 |
| [workflow/](workflow/) | 正式导出、独立作业、证据标注与冻结统计契约 |
| [eris/tools.json](eris/tools.json) | 分析助手工具参数 |

## 文件含义

- `request.schema.json`：Host 到 Agent 的可信请求。
- `submission.schema.json`：模型提交。Profile 可据可信请求收窄可选编号、槽位与数量。
- `result.schema.json`：程序绑定身份、展开证据并接受后的结果。
- `workflow/export.schema.json`：含稳定模型身份、源归因及派生判决的正式对比行，仅接受 `decided`。
- `attribution/problem.schema.json`：trace 与 session 共用的扁平 Problem，证据包含 position/component/quote/reason，计算只保留文字点评。
- `attribution/session-result.schema.json`：独立 Attribution workflow 的正式行；一行一个 session，包含 session_meta、turns、session_summary、session_problem。
- `workflow/clustering-tree.schema.json`：独立聚类完成后的树节点 JSONL；包含模型、功能责任、问题方向和细类，保留待观察问题及全部冻结回答的来源引用。
- `workflow/rewritten.schema.json`：Workflow 导出的改写文案；Agent 原始结果不包含该字段，存储与来源关联见[改写契约](../docs/contract.md#改写)。

提交方式、各阶段选择规则及 Rewrite 的固定 `rewrites: [{id,text}]` 见[数据契约](../docs/contract.md#提交方式与反馈)，不在导航中另抄字段清单。

[statistics-log.schema.json](workflow/statistics-log.schema.json) 是冻结的外部契约，读取与落盘均须严格校验。结构修改权限见 [AGENTS.md](../AGENTS.md#当前契约优先)。

[workflow/stability.schema.json](workflow/stability.schema.json) 是独立实验报告契约，不用于生产胜负统计。字段用途及保留理由见[字段用途清单](../docs/schema-fields.md)。

修改 Schema 时同步公开 Profile、解析与业务校验、当前调用方、提示词和测试；影响判词时更新 `evaluatorVersion`。验证入口见[开发指南](../docs/development.md#验证)。

Score 的 submission.schema.json 校验单次模型提交：12核心项、24诊断、源归因问题逐项映射及独立总分。result.schema.json 校验程序补齐目录身份、名称、分档、不可改写的源问题与精确证据后的正式结果。评分只消费已接受归因事实，不建立补查或定向重评协议。
