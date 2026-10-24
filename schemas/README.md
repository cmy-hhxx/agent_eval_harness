# Schema

[数据契约](../docs/contract.md) · [模块地图](../docs/modules/README.md)

本目录集中维护评测与 Eris 的 JSON Schema。原始输入由 [A / B 适配器](../packages/workflows/src/inputs/adapters.ts)解析，不属于 Agent 请求 Schema。

| 目录 | 内容 |
|---|---|
| [score/](score/) | 原skill单题0–10总分、12项0–4及24诊断输出 |
| [criteria/](criteria/) | 共同验收基准 |
| [attribution/](attribution/) | 单回答归因；`judgment.schema.json` 只校验程序绑定后的内部判断 |
| [instruction-review/](instruction-review/) | 后置独立指令检查、证据与核验账本 |
| [comparison/](comparison/) | 普通对比、可选核验及首查检查点 |
| [rewrite/](rewrite/) | 文本槽位改写 |
| [clustering/](clustering/) | 归类、问题库、待观察引用和来源复核 |
| [workflow/](workflow/) | 正式导出、独立作业、证据标注与统计交付 |
| [eris/tools.json](eris/tools.json) | 分析助手工具参数 |

## 文件含义

- `request.schema.json`：Host 到 Agent 的可信请求。
- `submission.schema.json`：模型提交。Profile 可据可信请求收窄可选编号、槽位与数量。
- `result.schema.json`：程序绑定身份、展开证据并接受后的结果。
- `workflow/export.schema.json`：含稳定模型身份、源归因及派生判决的正式对比行，仅接受 `decided`。
- `workflow/answer-review-attribution.schema.json`：独立归因正式行；点评采用Attribution公开结果契约，输入来源、实际trace_id与业务日期由Workflow绑定，落盘及恢复导出时校验。
- `workflow/clustering-tree.schema.json`：独立聚类完成后的树节点 JSONL；包含模型、功能责任、问题方向和细类，保留待观察问题及全部冻结回答的来源引用。
- `workflow/rewritten.schema.json`：Workflow 导出的改写文案；Agent 原始结果不包含该字段，正式 JSONL 的既有字段位置保持不变。

提交方式、各阶段选择规则及 Rewrite 的固定 `rewrites: [{id,text}]` 见[数据契约](../docs/contract.md#提交方式与反馈)，不在导航中另抄字段清单。

[statistics-log.schema.json](workflow/statistics-log.schema.json) 是冻结的外部契约，落盘和续传均须严格校验。结构修改权限见 [AGENTS.md](../AGENTS.md#当前契约优先)。

[workflow/mongo-publication.validator.json](workflow/mongo-publication.validator.json) 是共享交付集合的 MongoDB 校验规则，包含 BSON 类型与文档 ID 约束；部署方式见[自动化](../docs/automations.md#mongodb)。

[workflow/mongo-problems.validator.json](workflow/mongo-problems.validator.json) 用于问题库集合的类与样本记录；后训练专题记录必须携带专题标签和已验收快照范围，样本沿用持久输入 UUID，并绑定原归因收据。类、样本和专题模型分支均按集合校验规则交付，与统计日志契约独立。

专题的任务 ID、名称和批次由实际交付指定，通过文档 ID 隔离各任务的类与样本。部署集合校验前核对线上规则，保留集合中已有记录。

[workflow/stability.schema.json](workflow/stability.schema.json) 是独立实验报告契约，不用于生产胜负统计。字段用途及保留理由见[字段用途清单](../docs/schema-fields.md)。

修改 Schema 时同步公开 Profile、解析与业务校验、当前调用方、提示词和测试；影响判词时更新 `evaluatorVersion`。验证入口见[开发指南](../docs/development.md#验证)。

Score将取证、分项、总分的精简提交与正式结果分开校验。取证只提交facts（证据编号及受影响核心项）和unresolved，不提交共用对错判词；unresolved只用于取证恢复，评分阶段仅接收facts。程序补changed_item_ids，补查影响无法隔离时须说明full_rescore_reason，重复旧引用不能触发全量重评。正式result的evaluations与diagnostics为平级数组；内部片段不导出为正式评分。

axis提交与结果的基础Schema容纳1–6个轴；公开Profile按可信score_axes收窄核心项、诊断及问题引用范围，并逐轴校验全部判断。联合收据只做机械投影，独立总分仍不接收分项数值。
