# 单样本归因与评分

Attribution 使用独立 `workflow: attribution`，问财和 AIME 共用 Compact → 组件并行调查 → Trace 摘要 → Session 流程。一个输入记录分别输出一行 `compact.jsonl` 和 `attribution.jsonl`。字段、运行与恢复契约见 [Session 归因](attribution.md) 和 [使用指南](usage.md)。

## 归因职责与材料

Compact 字段任务提取原会话事实，组件任务并行调查各自问题；程序合并问题，Trace 只输出摘要及标准答案一致性。Session 只新增跨轮问题和整体总结，逐轮结果由 Workflow 原样回填。单轮 Session 由程序组装，不额外调用模型。材料与责任选择规则见[提示词与任务分工](attribution-prompt.md)。

外层原始 `meta` 直接传入 `session_meta`，trace 元数据直接传入对应 turn 的 `meta`。这些字段只供 Host 组装与落盘，不进入汇总模型的可见材料，也不由模型生成或改写。

Host 验证结构、身份、引用与原文坐标合法性，不做语义验收或效果复核。Compact 失败暂缓本 session 的归因，其余 session 继续；失败原因与未完成依赖保留在恢复状态中。完整结果和部分结果分别计数，暂停的 cancelled 不等于原始执行失败。

## 独立归因维度

Comparison 的指令遵循归因是一项独立维度：依据明确规则、适用条件、实际行为和证据分析偏离原因，不读取主归因判词。它与其他维度不互相依赖，也不成为正式 Comparison 的依赖。

维度通过 [统一定义](../packages/workflows/src/review/dimensions.ts) 登记 Agent、材料绑定和结果字段。调度、输出与恢复复用现有 Host/Workflow。KYC 等新维度需拥有明确的资料与归因规则，再接入该定义；当前没有内置 KYC 实现。独立 Attribution workflow 只运行上述主归因流程，不隐式增加维度任务。

## 评分与改写

Score 的 Agent 保留独立评分契约，尚未接入 session workflow。Rewrite 只接收需要润色的文本槽位，不接触证据，也不能改变归因结论。相关组合由调用方 Workflow 负责。

## 测量与恢复

运行进度优先读取活动 Host 的 `/api/progress`；`updated_at` 是观测时间，`checkpoint.savedAt` 是最近快照时间。Host 离线时，持久状态中的 running 不能证明模型仍在执行。

默认保存恢复索引、正式结果和报告；原始输入只保留在数据源，排查材料仅在 `--debug` 时写入 `_internal/`。同 run 续跑保留任务身份、已用预算和已接受结果，不因代码、模型或参数变化拒绝。

固定真实样本记录完整覆盖、部分产出、首次接受、超时、完整产出吞吐、Token、内存、IO 与事件循环。合法提交只能说明结构和证据坐标通过，不宣称语义正确率；不增加效果审查 Agent，不以问题条数或个人判词评价作为优化指标。实验方法和记录见 [吞吐实验](../evaluation-report/wencai-throughput.md)。
