# Schema

这里是仓库中评测及分析助手 Schema 的唯一集中目录。先看本页，再按任务打开对应文件；原始评测输入由 `a` / `b` 适配器接入，不维护覆盖所有来源格式的总 Schema。

| 目录 | 内容 |
|---|---|
| `criteria/` | 共同验收基准阶段的请求、`source_indices` 提交与程序生成的固定 `task_analysis`；submission/result 分离 |
| `attribution/` | 单条回答归因阶段的请求、模型提交和 Host 接受结果 |
| `comparison/` | 请求、普通草稿提交与结果；独立核验的原材料 inspection 与最终 verification-submission；首查与确认共用同任务预算 |
| `rewrite/` | 改写阶段的请求和结果；只交换文本槽位、不解析证据，因此提交与结果共用 `result.schema.json` |
| `clustering/` | 聚类阶段的请求、短编号提交和持久化身份结果；submission/result 分离；显式来源复核请求 occurrence-review.schema.json |
| `workflow/` | Workflow 组合后的正式导出、回溯标注与聚类产物 Schema |
| `eris/` | 独立分析助手的数据读取、专业任务、图表及总结工具输入 |

## 文件含义

- `request.schema.json`：Host 组装给 Agent 的内部请求护栏，不是原始数据源契约。
- `submission.schema.json`：模型通过提交工具返回的 JSON；有证据的阶段由 Profile 将 canonical evidence_id Schema 投影为模型 evidence_index 正整数选号 Schema，Host 先解析再校验完整坐标；canonical Schema 用于正式解析与 checkpoint 恢复。归因提交不重复写请求中已确定的 `has_standard_answer/task_analysis`；Comparison 同样不提交共同 `task_analysis`。
- `result.schema.json`：Host 解析并接受后的阶段结果；有证据的阶段使用 `message_index` 和 `quote`。归因结果由 Host 加入 `has_standard_answer/task_analysis`，对比结果由 Host 加入 `task_analysis`。
- `workflow/export.schema.json`：加入身份、模型信息、共同标准与归因任务引用、归因评语、回溯标注和派生判决后的正式两两对比行，仅接受 `status=decided`。
- `workflow/statistics-log.schema.json`：已冻结的统计日志外部契约，覆盖完整日志信封、累计总计、逐日统计和全部嵌套字段；所有 `wins` 同级紧随必填非负整数 `both_good / both_bad`，涵盖模型、场景、难度及趋势。生成日志落盘前与恢复日志上传前严格校验。仅允许数值、标签内容和日期条目更新，未经用户明确授权不得修改结构。
- `attribution/result.schema.json`、`comparison/result.schema.json`、`clustering/result.schema.json`：各自包含可选 `rewritten` 槽位，原字段不变；Workflow 在改写成功后写回。
- `workflow/clustering.schema.json`：聚类阶段接受后的归类产物行，按模型与批次引用观察和归类决定。
- `eris/tools.json`：独立分析助手的数据读取、专业任务、受限柱状图/折线图/饼图及总结工具输入，不接受自行填写的专业判词。图表只接收有来源引用的标签与有限数值，不接收 HTML、脚本、回调或远程数据配置。

Criteria 的 `submission.schema.json` 只接收三组 `{source_indices}` 数字选择，程序生成判据 ID；来源目录由程序从本题、已有标准答案及候选约束原文生成，解析后按 `result.schema.json` 接受固定共同 `task_analysis`。Attribution/Comparison 的提交不重复写此分析，Host 从请求镜像。Comparison 请求严格包含 A/B 两个候选及各自的当前归因；源归因的完整 `task_analysis` 必须与共同基准一致，否则程序定位来源并派生 `needs_review`；模型新增疑点只选择本方适用的程序槽。待复核结果单独写入 `comparison-review.jsonl`，不使用正式对比导出 Schema，不派生胜负。Comparison 的独立 `submission.schema.json` 只接收固定槽的评审、候选 summary、一次 preference 和 tradeoff，可附数字槽复核选择；关联、状态、覆盖、核心失败引用、决定性发现与 ranking 由程序生成。verification-submission 只接收 concern_matches 与可选槽复核选择，程序保留未匹配原发现和已有 pending，派生最终状态。正式 result 及统计结构保持不变；待核结果生成空排名、空矩阵与固定待核说明。Clustering 用独立的 `submission.schema.json` 接收请求内短编号，解析后按 `result.schema.json` 保存真实身份；Rewrite 的提交与结果共用 `result.schema.json`。

专业评测 Schema 修改顺序：Schema → 对应 Profile 的 `index.ts` → `validate.ts` /（如有）`resolve.ts` → [集中提示词](../packages/prompts/README.md)、测试样例和测试。分析助手工具输入改动同步 `agent/src/core/tools.ts`、提示词与测试。不要为旧 Schema 保留别名或兼容入口；项目哈希、摘要和跨 run 结果缓存规则见[开发指南](../docs/development.md#禁止项目哈希与兼容层)。
