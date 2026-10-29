# 模块地图

[架构](../architecture.md) · [开发与验证](../development.md)

跨包只用 package.json 的 exports。下表定位职责与主要入口；精确类型由公开导出维护，不在文档抄第二份依赖清单。

| 模块 | 职责 | 入口 |
|---|---|---|
| apps/host | CLI、配置、评测与 Eris 组装 | [cli.ts](../../apps/host/src/cli.ts)、[composition.ts](../../apps/host/src/composition.ts)、[agent.ts](../../apps/host/src/agent.ts) |
| apps/worker | Worker 进程入口 | [cli.ts](../../apps/worker/src/cli.ts) |
| agent | Eris 定义、产品接口与界面 | [Agent 说明](../../agent/README.md) |
| Contracts | 纯类型、协议、证据坐标与共用规则 | [index.ts](../../packages/contracts/src/index.ts) |
| Host | 通用调度、提交与恢复，不识别具体业务 | [runner.ts](../../packages/host/src/runner.ts)、[store.ts](../../packages/host/src/store.ts) |
| Score | 消费已接受归因，一次完成分项评分与独立总分 | [公开入口](../../packages/agents/src/score/index.ts) |
| Criteria | 共同验收基准 | [公开入口](../../packages/agents/src/criteria/index.ts) |
| Attribution | 单回答事实与责任 | [公开入口](../../packages/agents/src/attribution/index.ts) |
| 指令遵循归因 | 独立指令遵循归因与证据校验 | [公开入口](../../packages/agents/src/instruction-review/index.ts) |
| Comparison | 确认既有归因与两两判决 | [公开入口](../../packages/agents/src/comparison/index.ts) |
| Clustering | 归类、建类、合并与纯问题库规则 | [公开入口](../../packages/agents/src/clustering/index.ts) |
| Rewrite | 文本槽位校验 | [公开入口](../../packages/agents/src/rewrite/index.ts) |
| Workflow Inputs | 共用输入类型、来源编目、适配与按原始坐标重读 | [公开入口](../../packages/workflows/src/inputs/index.ts) |
| Workflow Review | 共用归因材料、证据、过程投影及业务结果复用与溯源 | [公开入口](../../packages/workflows/src/review/index.ts) · [正式结果复用](../../packages/workflows/src/review/business-result-repository.ts) |
| 归因维度 | 维度登记、独立材料绑定与结果封装 | [dimensions.ts](../../packages/workflows/src/review/dimensions.ts) |
| Comparison Workflow | 输入、盲测、阶段绑定、改写回填、责任摘要、稳定性实验与报告 | [index.ts](../../packages/workflows/src/comparison/index.ts) |
| Attribution Workflow | 独立 session 归因的任务规划、提交、恢复与正式导出 | [index.ts](../../packages/workflows/src/attribution/index.ts) |
| Data | 文件、锁、日志、存储与 IO | [index.ts](../../packages/data/src/index.ts) |
| Runtime | Worker、HTTP/SSE、会话及双 SDK | [客户端](../../packages/runtime/src/client-entry.ts)、[Worker](../../packages/runtime/src/server.ts)、[助手](../../packages/runtime/src/assistant.ts) |
| Tools | 证据、分页、图片、计算、代码与搜索 | [index.ts](../../packages/tools/src/index.ts) |
| Prompts | 全部模型可见规则与工具文案 | [说明](../../packages/prompts/README.md) |
| Schemas | 集中 JSON 资源，构建时复制 | [说明](../../schemas/README.md) |
| evaluation-report | 已交付报告、研究与历史快照，只读保留 | [说明](../../evaluation-report/README.md) |


## 跨模块修改

Agent 之间不互相导入；Workflow 通过公开入口组合。Host 只接收定义，应用层注入具体 Agent、存储和 Runtime。依赖限制由[架构测试](../../tests/architecture/dependencies.test.ts)执行。

Comparison 复用 Attribution 的 component → trace → session 任务规划和材料绑定；共用输入与材料模块不导入具体 Workflow。跨包调用共用能力使用 `@eval/workflows/inputs`、`@eval/workflows/review`。

Comparison 的额外归因维度在 `attributionDimensions` 登记：名称、Agent、材料绑定与结果字段由维度定义拥有，任务生成、调度、输出与恢复使用共用逻辑。当前登记指令遵循归因；其任务只关联本回答的 session 来源，不依赖其他维度，也不接收既有归因判词。添加用户 KYC 等维度时实现相应材料绑定、Agent 与 Schema，再登记定义；不修改 Host 或组件归因，不复用指令规则冒充 KYC 规则。独立 Attribution workflow 当前仍只执行三段主归因。

Comparison 的归因输入由自身公开契约定义，Workflow 显式投影摘要、任务标准、判据、核心结论、正确性核查和 finding；保留证据坐标、数值与表格核查、标准答案冲突事实和原序号，隔离责任调查及内部 finding ID。表格来源复核在投影前从完整归因派生。`rewritten` 只属于 Workflow 导出与展示，不进入 Agent 原始结果。各 Agent Profile 声明提交方式和草稿预算，Prompts 只渲染传入选项。

常规 Comparison 的模型材料只呈现一份完整会话问答，不重复附加 turns、正文引用副本和引用目录；长答案直接呈现，冲突仍可定向读取来源。提交 Schema 按 criterion/resource 分组约束槽位编号，不为每个槽重复整份行定义。可选 verification 的分段读取流程保持独立。

评分槽通过 criterion_ids 引用 task_analysis 中的唯一标准。常规 Comparison 只使用原文读取、搜索和图片查看工具核对决定性冲突，计算与责任调查留在归因；资源比较由程序读取已记录指标。

验证先找模块同目录的 .test.ts，跨模块行为看 tests/integration/host；直接 SDK 看 tests/integration。具体命令见[开发指南](../development.md#验证)。

Eris 从外置产物清单指定的目录发现运行与公开资产，读取正式结果和 `overview.json` 的各 run 统计；不推导来源或目录名称，不经清洗服务或外部发布链。[目录解析](../../packages/data/src/evaluation-collections.ts)校验业务 ID、路径与测试标记。账户、模型与会话由应用 Host 注入，分析工具通过公开 Workflow 入口定位原回答和证据。
