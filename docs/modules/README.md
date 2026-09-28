# 模块地图

[返回架构](../architecture.md) · [开发与验证](../development.md)

按任务只打开对应模块行和公开入口；需要验证时再看最后一列。每个目录表示一个职责边界，公开入口以 `package.json` 的 `exports` 为准，跨包禁止穿透内部路径。

| 模块 | 职责与修改位置 | 公开入口 | 项目依赖 | 验证入口 |
|---|---|---|---|---|
| 应用 Host | [CLI](../../apps/host/src/cli.ts)、[看板服务](../../apps/host/src/dashboard.ts)、[看板视图模块](../../apps/host/dashboard/dashboard-view.js)、[数据与流程](../../apps/host/src/dashboard-reference.ts)、[配置](../../apps/host/src/config.ts)、[组装](../../apps/host/src/composition.ts) | 根 `eval`；`@eval/host-app/config`、`composition` | Host、具体 Agent / Workflow、Data | 配置、看板、跨模块回归、doctor |
| Eris | [完整定义](../../agent/src/core/profile.ts)、[核心工具](../../agent/src/core/tools.ts)、[产品接口](../../agent/src/server/index.ts)、[原界面装配](../../agent/src/client/main.js) | `@eval/assistant`、`@eval/assistant/server` | Contracts、Prompts、Tools、Runtime；具体业务由应用 Host 注入 | 会话、浏览器、原上游回归与性能 |
| 应用 Worker | [底座与进程入口](../../apps/worker/src/cli.ts) | 根 `worker` | Runtime、Contracts | 双 SDK 集成、独立构建 |
| Contracts | [通用接口、JSON 与协议](../../packages/contracts/src/index.ts) | `@eval/contracts` | 无 IO / SDK | 类型检查、架构测试 |
| Host | [调度](../../packages/host/src/runner.ts)、[提交与恢复](../../packages/host/src/store.ts)、[Profile 契约](../../packages/host/src/agents.ts)、进度 | `@eval/host` | Contracts、Data、Runtime 客户端/HTTP | 提交与恢复、通用 JSON 隔离 |
| Comparison | [默认 Profile](../../packages/agents/src/comparison/index.ts)、业务校验与[根目录 schemas/comparison](../../schemas/comparison/)、validate | `@eval/agents/comparison` | Contracts、Tools、Prompts | 同目录单元测试、组合判决 |
| Attribution | [归因 Profile](../../packages/agents/src/attribution/index.ts)、集中提示词与[根目录 schemas/attribution](../../schemas/attribution/)、resolve/validate | `@eval/agents/attribution` | Contracts、Tools、Prompts | 同目录单元测试、问题描述 |
| Clustering | [聚类 Profile 与纯问题库规则](../../packages/agents/src/clustering/index.ts)、集中提示词与[根目录 schemas/clustering](../../schemas/clustering/)、归类/合并校验 | `@eval/agents/clustering` | Contracts、Prompts | 同目录单元测试、库合并与上限 |
| Rewrite | [改写 Profile](../../packages/agents/src/rewrite/index.ts)、集中提示词与[根目录 schemas/rewrite](../../schemas/rewrite/)、槽位校验 | `@eval/agents/rewrite` | Contracts、Prompts | 同目录单元测试、评语改写 |
| Comparison Workflow | [输入适配器](../../packages/workflows/src/comparison/adapters.ts)、[输入分组](../../packages/workflows/src/comparison/input.ts)、[评测集索引](../../packages/workflows/src/comparison/input-catalog.ts)、[看板只读投影](../../packages/workflows/src/comparison/dashboard-view.ts)、[材料映射](../../packages/workflows/src/comparison/workflow.ts)、[纯编解码](../../packages/workflows/src/comparison/codec.ts)、报告 | `@eval/workflows/comparison` | Contracts、Data、Tools、Agent 公开类型、根目录 schemas/workflow | 适配器注册表、盲测、批次、结果、续跑 |
| Data | [文件与锁](../../packages/data/src/files.ts)、[会话追加记录](../../packages/data/src/assistant-store.ts)、[运行目录布局](../../packages/data/src/run-layout.ts)、[源解析](../../packages/data/src/sources.ts)、[输入索引存储](../../packages/data/src/input-catalog.ts)、[问题库存储](../../packages/data/src/problem-library-store.ts)、[Repository](../../packages/data/src/repository.ts)、[日志](../../packages/data/src/logging.ts) | `@eval/data` | Contracts | 原子保存、追加中断、崩溃恢复、日志并行与去重 |
| Runtime | [客户端](../../packages/runtime/src/client.ts)、[Worker](../../packages/runtime/src/server.ts)、HTTP/SSE、[Pi 会话与执行者](../../packages/runtime/src/assistant-sessions.ts)、[原始材料只读解析](../../packages/runtime/src/assistant-source.ts)、Deepseek HTTP RPC / WebSocket、`adapters/pi.ts` / `prime.ts` | `@eval/runtime/client`、`http`、`worker`、`pi`、`prime`、`assistant` | Contracts、Data、Tools | Worker 回归、SDK 集成、干净安装 |
| Tools | [注册与执行](../../packages/tools/src/index.ts)、证据、分页、图片、代码与产物 | `@eval/tools` | Contracts、Data | 工具与进程生命周期 |
| Prompts | [集中提示词模块](../../packages/prompts/README.md)、阶段规则、工具描述、组装 | `@eval/prompts` | Contracts | 文案、工具覆盖和实际发送内容 |
| Schemas | [根目录 Schema 模块](../../schemas/README.md)、Attribution / Comparison / Rewrite / Clustering / Workflow Schema | 根目录 `schemas/` | 被 Agents 与 Workflow 读取 | JSON Schema 与文档一致性 |

Agent 不导入其他 Agent 或 Workflow。新增 Profile 在 `packages/prompts` 配套提交提示词与工具描述，在 Agent 目录提交校验、测试样例和单元测试，并在根目录 `schemas/<stage>/` 增加或修改 Schema，在应用组装处登记。Workflow 负责组合和输入映射，Agent 不读取其他 Agent 的实现或状态。改写 Agent 只认文本槽位，槽位选择、回填和 commentary 产物由 Comparison Workflow 维护；聚类 Agent 拥有问题库，归因只提供问题描述，工作流负责按 `(模型 × 批次)` 分片组合观察，并通过 Data 的模型锁读改写问题库。

正式对比结果由 [Workflow Schema](../../packages/workflows/src/comparison/schema.ts)引用两个 Agent 的接受结果 Schema，再添加身份、对错摘要与回溯字段；Workflow 自己的 [export schema](../../schemas/workflow/export.schema.json) 只描述这层正式导出，改写产物由 [commentary schema](../../schemas/workflow/commentary.schema.json) 描述，聚类产物由 [clustering schema](../../schemas/workflow/clustering.schema.json) 描述。Schema 统一存放在[根目录 schemas 模块](../../schemas/README.md)，Agent 的业务结构仍在各自目录的校验和类型中维护；模型可见文案集中在[提示词模块](../../packages/prompts/README.md)。

Eris 通过 `createEris` 统一装配独立的 [提示词与工具说明](../../packages/prompts/resources/eris/)、[工具 Schema](../../schemas/eris/tools.json) 和执行器；修改入口见 [Eris 定义](../../agent/README.md#修改-eris)。`AnalysisDataSource`、`SpecialistGateway`、`AssistantSessionRuntime` 和执行者协调接口位于 [Contracts](../../packages/contracts/src/assistant.ts)。单任务入口 [runAgentTask](../../packages/host/src/single-task.ts) 复用 Host 执行、校验和结果提交；[应用专业网关](../../apps/host/src/assistant-specialists.ts) 通过 Workflow 的公开 `bindTask` 复用材料与盲测规则，不创建批量 Workflow。

分析助手的网关模型发现位于 Runtime，模型目录与常用模型组装位于应用 Host，用户选择 IO 位于 Data；客户端装配上游模型选择、命令入口和模型勾选组件。Pi 正文中的 `<think>` 包装只在展示适配时归入 reasoning，不改写原始恢复消息。

分析助手设置通过原有 Deepseek ConfigForms / settings RPC 读写，Runtime 适配上游设置 Schema，Data 按用户保存偏好并检查并发修改；前端沿用上游通用设置面板和各功能控件。
