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
| 数据服务 | `/data/` 包处理、ready、样本与同机进度 | [app.py](../../server_dashboard_ths/app.py) |
| evaluation-report | 独立离线汇报与历史快照 | [说明](../../evaluation-report/README.md) |

## 跨模块修改

Agent 之间不互相导入；Workflow 通过公开入口组合。Host 只接收定义，应用层注入具体 Agent、存储和 Runtime。依赖限制由[架构测试](../../tests/architecture/dependencies.test.ts)执行。

验证先找模块同目录的 .test.ts，跨模块行为看 tests/integration/host；直接 SDK 看 tests/integration。具体命令见[开发指南](../development.md#验证)。
