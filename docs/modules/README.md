# 模块地图

[架构](../architecture.md) · [开发与验证](../development.md)

跨包只用 package.json 的 exports。下表定位职责与主要入口；精确类型由公开导出维护，不在文档抄第二份依赖清单。

| 模块 | 职责 | 入口 |
|---|---|---|
| apps/host | CLI、配置、组装、工作台 supervisor、登录/relay API、看板及自动化应用 | [workbench.ts](../../apps/host/src/workbench.ts)、[cli.ts](../../apps/host/src/cli.ts)、[dashboard.ts](../../apps/host/src/dashboard.ts)、[automation-command.ts](../../apps/host/src/automation-command.ts) |
| apps/worker | Worker 进程入口 | [cli.ts](../../apps/worker/src/cli.ts) |
| agent | Eris 定义、产品接口与界面 | [Agent 说明](../../agent/README.md) |
| Contracts | 纯类型、协议、证据坐标与共用规则 | [index.ts](../../packages/contracts/src/index.ts) |
| Automations | 通道调度、恢复与交付状态机 | [index.ts](../../packages/automations/src/index.ts) |
| Host | 通用调度、提交与恢复，不识别具体业务 | [runner.ts](../../packages/host/src/runner.ts)、[store.ts](../../packages/host/src/store.ts) |
| Criteria | 共同验收基准 | [公开入口](../../packages/agents/src/criteria/index.ts) |
| Attribution | 单回答事实与责任 | [公开入口](../../packages/agents/src/attribution/index.ts) |
| Comparison | 确认既有归因与两两判决 | [公开入口](../../packages/agents/src/comparison/index.ts) |
| Clustering | 归类、建类、合并与纯问题库规则 | [公开入口](../../packages/agents/src/clustering/index.ts) |
| Rewrite | 文本槽位校验 | [公开入口](../../packages/agents/src/rewrite/index.ts) |
| Comparison Workflow | 输入、盲测、阶段绑定、改写回填、责任摘要、稳定性实验与报告 | [index.ts](../../packages/workflows/src/comparison/index.ts) |
| Data | 文件、锁、日志、存储与 IO | [index.ts](../../packages/data/src/index.ts) |
| Runtime | Worker、HTTP/SSE、会话及双 SDK | [客户端](../../packages/runtime/src/client-entry.ts)、[Worker](../../packages/runtime/src/server.ts)、[助手](../../packages/runtime/src/assistant.ts) |
| Tools | 证据、分页、图片、计算、代码与搜索 | [index.ts](../../packages/tools/src/index.ts) |
| Prompts | 全部模型可见规则与工具文案 | [说明](../../packages/prompts/README.md) |
| Schemas | 集中 JSON 资源，构建时复制 | [说明](../../schemas/README.md) |
| 数据服务 | `/data/` 任务/压缩包批次、清洗报告、输入发布、ready、样本与同机进度 | [app.py](../../server_dashboard_ths/app.py)、[任务批次](../../server_dashboard_ths/workbench_catalog.py)、[清洗报告](../../server_dashboard_ths/cleaning_report.py) |
| evaluation-report | 独立离线汇报与历史快照 | [说明](../../evaluation-report/README.md) |

批次启动关联与接口由 `apps/host/src/dashboard-batches.ts`、`dashboard.ts` 组装；运行错误业务坐标由 Workflow 的 `run-errors.ts` 投影，统一日志由 Data 的 RuntimeLogReader 读取。页面不解释判词，也不写正式结果。

## 跨模块修改

Agent 之间不互相导入；Workflow 通过公开入口组合。Host 只接收定义，应用层注入具体 Agent、存储和 Runtime。依赖限制由[架构测试](../../tests/architecture/dependencies.test.ts)执行。

验证先找模块同目录的 .test.ts，跨模块行为看 tests/integration/host；直接 SDK 看 tests/integration。具体命令见[开发指南](../development.md#验证)。

工作台结果与分析入口：`apps/host/src/dashboard-analysis.ts` 登记任务/批次/运行选择和分析占用；`packages/workflows/src/comparison/analysis-scope.ts` 投影已接受归因身份，`clustering-job.ts` 校验冻结来源并复用独立作业。`packages/data/src/run-artifacts.ts` 枚举公开报告与结果，页面不读取 state 或 debug 材料。

双日常来源由 `apps/host/src/daily-workbench.ts` 组合控制与查询：问财调用既有自动化，AIME通过 `aime-workbench.ts` 复用CLI同一执行器。包覆盖只关联清洗坐标和当前正式收据，结果按comparison/answer-review公开入口读取；共享Host通过独立pauseSignal收尾，模型请求额度按来源隔离。
