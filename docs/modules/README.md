# 模块地图

[返回架构](../architecture.md) · [开发与验证](../development.md)

按任务只打开对应模块行和公开入口；需要验证时再看最后一列。每个目录表示一个职责边界，公开入口以 `package.json` 的 `exports` 为准，跨包禁止穿透内部路径。

| 模块 | 职责与修改位置 | 公开入口 | 项目依赖 | 验证入口 |
|---|---|---|---|---|
| 应用 Host | [CLI](../../apps/host/src/cli.ts)、[看板](../../apps/host/src/dashboard.ts)、[配置](../../apps/host/src/config.ts)、[组装](../../apps/host/src/composition.ts) | 根 `eval`；`@eval/host-app/config`、`composition` | Host、具体 Agent / Workflow、Data | 配置、看板、跨模块回归、doctor |
| 应用 Worker | [底座与进程入口](../../apps/worker/src/cli.ts) | 根 `worker` | Runtime、Contracts | 双 SDK 集成、独立构建 |
| Contracts | [通用接口、JSON 与协议](../../packages/contracts/src/index.ts) | `@eval/contracts` | 无 IO / SDK | 类型检查、架构测试 |
| Host | [调度](../../packages/host/src/runner.ts)、[提交与恢复](../../packages/host/src/store.ts)、[Profile 契约](../../packages/host/src/agents.ts)、进度 | `@eval/host` | Contracts、Data、Runtime 客户端/HTTP | 提交与恢复、通用 JSON 隔离 |
| Comparison | [默认 Profile](../../packages/agents/src/comparison/index.ts)、提示词与[根目录 schemas/comparison](../../schemas/comparison/)、validate | `@eval/agents/comparison` | Contracts、Tools | 同目录单元测试、组合判决 |
| Attribution | [归因 Profile 与问题库](../../packages/agents/src/attribution/index.ts)、提示词与[根目录 schemas/attribution](../../schemas/attribution/)、resolve/validate、库合并/血缘 | `@eval/agents/attribution` | Contracts、Tools | 同目录单元测试、归因树 |
| Rewrite | [改写 Profile](../../packages/agents/src/rewrite/index.ts)、提示词与[根目录 schemas/rewrite](../../schemas/rewrite/)、槽位校验 | `@eval/agents/rewrite` | Contracts | 同目录单元测试、评语改写 |
| Comparison Workflow | [输入适配器](../../packages/workflows/src/comparison/adapters.ts)、[输入分组](../../packages/workflows/src/comparison/input.ts)、[看板只读投影](../../packages/workflows/src/comparison/dashboard-view.ts)、[材料映射](../../packages/workflows/src/comparison/workflow.ts)、[纯编解码](../../packages/workflows/src/comparison/codec.ts)、报告 | `@eval/workflows/comparison` | Contracts、Data、Tools、Agent 公开类型、根目录 schemas/workflow | 适配器注册表、盲测、批次、结果、续跑 |
| Data | [文件与锁](../../packages/data/src/files.ts)、[运行目录布局](../../packages/data/src/run-layout.ts)、[源解析](../../packages/data/src/sources.ts)、[归因树存储](../../packages/data/src/attribution-store.ts)、[Repository](../../packages/data/src/repository.ts)、[日志](../../packages/data/src/logging.ts) | `@eval/data` | Contracts | 原子保存、追加中断、崩溃恢复、日志并行与去重 |
| Runtime | [客户端](../../packages/runtime/src/client.ts)、[Worker](../../packages/runtime/src/server.ts)、HTTP/SSE、`adapters/pi.ts` / `prime.ts` | `@eval/runtime/client`、`http`、`worker`、`pi`、`prime` | Contracts、Data、Tools | Worker 回归、SDK 集成、干净安装 |
| Tools | [注册与执行](../../packages/tools/src/index.ts)、证据、分页、图片、代码与产物 | `@eval/tools` | Contracts、Data | 工具与进程生命周期 |
| Schemas | [根目录 Schema 模块](../../schemas/README.md)、Attribution / Comparison / Rewrite / Workflow Schema | 根目录 `schemas/` | 被 Agents 与 Workflow 读取 | JSON Schema 与文档一致性 |

Agent 不导入其他 Agent 或 Workflow。新增 Profile 配套提交提示词、校验、样例和单元测试，并在根目录 `schemas/<stage>/` 增加或修改 Schema，在应用组装处登记。Workflow 负责组合和输入映射，Agent 不读取其他 Agent 的实现或状态。改写 Agent 只认文本槽位，槽位选择、回填和 commentary 产物由 Comparison Workflow 维护；聚类的预留位置见[架构](../architecture.md#接口和底座路由)。

正式对比结果由 [Workflow Schema](../../packages/workflows/src/comparison/schema.ts)引用两个 Agent 的接受结果 Schema，再添加身份、对错摘要与回溯字段；Workflow 自己的 [export schema](../../schemas/workflow/export.schema.json) 只描述这层正式导出，改写产物由 [commentary schema](../../schemas/workflow/commentary.schema.json) 单独描述。Schema 统一存放在[根目录 schemas 模块](../../schemas/README.md)，Agent 的业务结构仍在各自目录的校验、类型和提示词中维护。
