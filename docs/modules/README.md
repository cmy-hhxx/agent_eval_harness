# 模块地图

[返回架构](../architecture.md) · [开发与验证](../development.md)

按任务只打开对应模块行和公开入口；需要验证时再看最后一列。每个目录表示一个职责边界，公开入口以 `package.json` 的 `exports` 为准，跨包禁止穿透内部路径。

| 模块 | 职责与修改位置 | 公开入口 | 项目依赖 | 验证入口 |
|---|---|---|---|---|
| 应用 Host | [CLI](../../apps/host/src/cli.ts)、[看板服务](../../apps/host/src/dashboard.ts)、[日期盘点与预检复用](../../apps/host/src/dashboard-inputs.ts)、[看板视图模块](../../apps/host/dashboard/dashboard-view.js)、[数据与流程](../../apps/host/src/dashboard-reference.ts)、[问题库页面](../../apps/host/dashboard/problems.html)、[评测配置](../../apps/host/src/config.ts)、[INI 渠道配置](../../apps/host/src/settings.ts)、[组装](../../apps/host/src/composition.ts) | 根 `eval`；`@eval/host-app/config`、`settings`、`composition` | Host、具体 Agent / Workflow、Data | 配置、看板、问题库树与样本召回、跨模块回归、doctor |
| Eris | [完整定义](../../agent/src/core/profile.ts)、[核心工具](../../agent/src/core/tools.ts)、[产品接口](../../agent/src/server/index.ts)、[原界面装配](../../agent/src/client/main.js) | `@eval/assistant`、`@eval/assistant/server` | Contracts、Prompts、Tools、Runtime；具体业务由应用 Host 注入 | 会话、浏览器、原上游回归与性能 |
| 应用 Worker | [底座与进程入口](../../apps/worker/src/cli.ts) | 根 `worker` | Runtime、Contracts、应用 Settings | 双 SDK 集成、独立构建 |
| Contracts | [通用接口、JSON 与协议](../../packages/contracts/src/index.ts)、[证据坐标](../../packages/contracts/src/evidence.ts)、[必读区间归并与页额度](../../packages/contracts/src/required-reading.ts) | `@eval/contracts` | 无 IO / SDK | 类型检查、架构测试 |
| Automations | [流水线、恢复与退避](../../packages/automations/src/index.ts)、Mongo 增量同步与四小时日志交付、[共享监控投影](../../apps/host/src/automation-monitor.ts)与[只读看板](../../apps/host/src/automation-dashboard.ts)；[使用与状态](../automations.md) | `@eval/automations`；根 `automations`、[automation.sh](../../automation.sh) | Contracts；应用注入 Runtime / Data / Host / Workflow | 下载完整性、队列并行、历史接管、全阶段、上传续传与回执、时段统计与看板 |
| Host | [调度](../../packages/host/src/runner.ts)、[提交与恢复](../../packages/host/src/store.ts)、[Profile 契约](../../packages/host/src/agents.ts)、进度 | `@eval/host` | Contracts、Data、Runtime 客户端/HTTP | 提交与恢复、通用 JSON 隔离 |
| Criteria | [验收基准 Profile](../../packages/agents/src/criteria/index.ts)，只读问题、标准答案和候选约束原文、固定逐项验收规则 | `@eval/agents/criteria` | Contracts、Prompts | 来源覆盖、作用域、唯一 ID、材料边界 |
| Comparison | [默认 Profile](../../packages/agents/src/comparison/index.ts)、业务校验与[根目录 schemas/comparison](../../schemas/comparison/)、validate | `@eval/agents/comparison` | Contracts、Tools、Prompts | 同目录单元测试、组合判决 |
| Attribution | [归因 Profile](../../packages/agents/src/attribution/index.ts)、集中提示词与[根目录 schemas/attribution](../../schemas/attribution/)、resolve/validate | `@eval/agents/attribution` | Contracts、Tools、Prompts | 同目录单元测试、问题描述 |
| Clustering | [聚类 Profile 与纯问题库规则](../../packages/agents/src/clustering/index.ts)、集中提示词与[根目录 schemas/clustering](../../schemas/clustering/)、归类/延期、类维护、显式样本复核纯事件与有效投影 | `@eval/agents/clustering` | Contracts、Prompts | 同目录单元测试、库维护幂等、合并与上限 |
| Rewrite | [改写 Profile](../../packages/agents/src/rewrite/index.ts)、集中提示词与[根目录 schemas/rewrite](../../schemas/rewrite/)、槽位校验 | `@eval/agents/rewrite` | Contracts、Prompts | 同目录单元测试、评语改写 |
| Comparison Workflow | [输入适配器](../../packages/workflows/src/comparison/adapters.ts)、[输入扫描、预检索引与分组](../../packages/workflows/src/comparison/input.ts)、[评测集索引](../../packages/workflows/src/comparison/input-catalog.ts)、[看板只读投影](../../packages/workflows/src/comparison/dashboard-view.ts)、[材料映射](../../packages/workflows/src/comparison/binding.ts)、[可选核验准备](../../packages/workflows/src/comparison/verification-preparation.ts)、[纯编解码](../../packages/workflows/src/comparison/codec.ts)、报告 | `@eval/workflows/comparison` | Contracts、Data、Tools、Agent 公开入口、根目录 schemas/workflow | 适配器注册表、盲测、批次、结果、续跑、问题库只读投影、主题计数、延期重归类与召回定位 |
| Data | [文件与锁](../../packages/data/src/files.ts)、[会话追加记录](../../packages/data/src/assistant-store.ts)、[运行目录布局](../../packages/data/src/run-layout.ts)、[源解析](../../packages/data/src/sources.ts)、[输入索引存储](../../packages/data/src/input-catalog.ts)、[问题库存储](../../packages/data/src/problem-library-store.ts)、[Repository](../../packages/data/src/repository.ts)、[日志](../../packages/data/src/logging.ts)、[运行删除](../../packages/data/src/run-deletion.ts) | `@eval/data` | Contracts | 原子保存、追加中断、崩溃恢复、日志并行与去重 |
| Runtime | [客户端](../../packages/runtime/src/client.ts)、[Worker](../../packages/runtime/src/server.ts)、HTTP/SSE、[Pi 会话与执行者](../../packages/runtime/src/assistant-sessions.ts)、[原始材料只读解析](../../packages/runtime/src/assistant-source.ts)、Deepseek HTTP RPC / WebSocket、`adapters/pi.ts` / `prime.ts` | `@eval/runtime/client`、`http`、`worker`、`pi`、`prime`、`assistant` | Contracts、Data、Tools | Worker 回归、SDK 集成、干净安装 |
| Tools | [注册与执行](../../packages/tools/src/index.ts)、[外部搜索](../../packages/tools/src/serper.ts)、[公开原文提取](../../packages/tools/src/web-reader.ts)、证据、分页、图片、代码与产物 | `@eval/tools` | Contracts、Data | 工具、搜索响应与进程生命周期 |
| Prompts | [集中提示词模块](../../packages/prompts/README.md)、阶段规则、工具描述、组装 | `@eval/prompts` | Contracts | 文案、工具覆盖和实际发送内容 |
| Schemas | [根目录 Schema 模块](../../schemas/README.md)、Criteria / Attribution / Comparison / Rewrite / Clustering / Workflow Schema | 根目录 `schemas/` | 被 Agents 与 Workflow 读取 | JSON Schema 与文档一致性 |
| 离线汇报 | [离线成品](../../evaluation-report/report.html)、[源码与构建说明](../../evaluation-report/README.md)，SVG 机制图、提示词与案例快照 | `node evaluation-report/scripts/build.mjs` 生成单文件；浏览器直接打开 | 无业务代码依赖，不接入项目运行或构建 | 模块构建测试、快照分母、一级导航、原文阅读、单文件再打开与响应式核验 |

## 跨模块修改

- Agent 规则改动同步提示词、Schema、解析、业务校验与测试；公共规则见[仓库约束](../../AGENTS.md#模块边界)。
- 比较流程由 Workflow 组合：`review.ts` 管归因补查，`verification-preparation.ts` 准备可选核验，`commentary.ts` 选择与回填改写槽位，`problem-library.ts` 通过 Data 锁更新问题库。语义见[数据契约](../contract.md)。
- 看板、问题库和 Eris 只读取 Workflow 的公开投影；[analysis-progress.ts](../../packages/workflows/src/comparison/analysis-progress.ts) 统计任务进度，[analysis-comparison.ts](../../packages/workflows/src/comparison/analysis-comparison.ts) 汇总正式战绩。[应用专业网关](../../apps/host/src/assistant-specialists.ts) 构造小计划并复用 Host；[代码核验装配](../../apps/host/src/assistant-code.ts) 复用通用执行器并提供会话产物分页。
- Eris 的数据、搜索、专业任务和会话接口在 [Contracts](../../packages/contracts/src/assistant.ts)；工具与界面入口见[修改 Eris](../../agent/README.md#修改-eris)，运行与恢复见[架构](../architecture.md#独立分析助手)。
