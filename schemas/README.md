# Schema

[数据契约](../docs/contract.md) · [模块地图](../docs/modules/README.md)

本目录集中维护评测与 Eris 的 JSON Schema。原始输入由 [A / B 适配器](../packages/workflows/src/comparison/adapters.ts)解析，不属于 Agent 请求 Schema。

| 目录 | 内容 |
|---|---|
| [criteria/](criteria/) | 共同验收基准 |
| [attribution/](attribution/) | 单回答归因；`judgment.schema.json` 只校验程序绑定后的内部判断 |
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

提交方式、各阶段选择规则及 Rewrite 的固定 `rewrites: [{id,text}]` 见[数据契约](../docs/contract.md#提交方式与反馈)，不在导航中另抄字段清单。

[statistics-log.schema.json](workflow/statistics-log.schema.json) 是冻结的外部契约，落盘和续传均须严格校验。结构修改权限见 [AGENTS.md](../AGENTS.md#当前契约优先)。

[workflow/mongo-publication.validator.json](workflow/mongo-publication.validator.json) 是共享交付集合的 MongoDB 校验规则，包含 BSON 类型与文档 ID 约束；部署方式见[自动化](../docs/automations.md#mongodb)。

[workflow/mongo-problems.validator.json](workflow/mongo-problems.validator.json) 用于问题库集合的类与样本记录；后训练专题记录必须携带专题标签和已验收快照范围，样本沿用持久输入 UUID，并绑定原归因收据。手动交付保留现有类与样本的校验，新增专题模型分支，不修改统计日志契约。

[workflow/stability.schema.json](workflow/stability.schema.json) 是独立实验报告契约，不用于生产胜负统计。字段用途及本轮保留理由见[字段用途清单](../docs/schema-fields.md)。

修改 Schema 时同步公开 Profile、解析与业务校验、当前调用方、提示词和测试；影响判词时更新 `evaluatorVersion`。验证入口见[开发指南](../docs/development.md#验证)。
