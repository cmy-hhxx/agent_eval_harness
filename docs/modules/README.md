# 模块地图

[返回架构](../architecture.md) · [开发与验证](../development.md)

每个目录表示一个职责边界。公开入口以 `package.json` 的 `exports` 为准，跨包禁止穿透内部路径。

| 模块 | 职责与修改位置 | 公开入口 | 项目依赖 | 验证入口 |
|---|---|---|---|---|
| 应用 Host | [CLI](../../apps/host/src/cli.ts)、[配置](../../apps/host/src/config.ts)、[组装](../../apps/host/src/composition.ts) | 根 `eval`；`@eval/host-app/config`、`composition` | Host、具体 Agent / Workflow、Data | 配置、跨模块回归、doctor |
| 应用 Worker | [底座与进程入口](../../apps/worker/src/cli.ts) | 根 `worker` | Runtime、Contracts | 双 SDK 集成、独立构建 |
| Contracts | [通用接口、JSON 与协议](../../packages/contracts/src/index.ts) | `@eval/contracts` | 无 IO / SDK | 类型检查、架构测试 |
| Host | [调度](../../packages/host/src/runner.ts)、[提交与恢复](../../packages/host/src/store.ts)、[Profile 契约](../../packages/host/src/agents.ts)、进度 | `@eval/host` | Contracts、Data、Runtime 客户端/HTTP | 提交与恢复、通用 JSON 隔离 |
| Comparison | [默认 Profile](../../packages/agents/src/comparison/index.ts)、`profiles/default` 提示词和 Schema、resolve/validate | `@eval/agents/comparison` | Contracts、Tools | 同目录单元测试、组合判决 |
| Critique | [correctness Profile](../../packages/agents/src/critique/index.ts)、`profiles/correctness`、resolve/validate | `@eval/agents/critique` | Contracts、Tools | 同目录单元测试、正确性收据 |
| Pairwise Workflow | [输入配对](../../packages/workflows/src/pairwise/input.ts)、[材料映射](../../packages/workflows/src/pairwise/workflow.ts)、[纯编解码](../../packages/workflows/src/pairwise/codec.ts)、报告 | `@eval/workflows/pairwise` | Contracts、Data、Tools、Agent 公开类型/Schema | A/AA、盲测、批次、结果、续跑 |
| Data | [文件与锁](../../packages/data/src/files.ts)、[源读取](../../packages/data/src/sources.ts)、[Repository](../../packages/data/src/repository.ts)、[日志](../../packages/data/src/logging.ts) | `@eval/data` | Contracts | 原子保存、追加中断、崩溃恢复、日志并行与去重 |
| Runtime | [客户端](../../packages/runtime/src/client.ts)、[Worker](../../packages/runtime/src/server.ts)、HTTP/SSE、`adapters/pi.ts` / `prime.ts` | `@eval/runtime/client`、`http`、`worker`、`pi`、`prime` | Contracts、Data、Tools | Worker 回归、SDK 集成、干净安装 |
| Tools | [注册与执行](../../packages/tools/src/index.ts)、证据、分页、图片、代码与产物 | `@eval/tools` | Contracts、Data | 工具与进程生命周期 |

Agent 不导入其他 Agent 或 Workflow。新增 Profile 配套提交提示词、Schema、校验、样例和单元测试，在应用组装处登记。Workflow 负责组合和输入映射，Agent 不读取其他 Agent 的实现或状态。归因与聚类的预留位置见[架构](../architecture.md#接口和底座路由)。

正式结果由 [Workflow Schema](../../packages/workflows/src/pairwise/schema.ts)引用 Comparison 的公开结果 Schema，再添加身份、正确性摘要与回溯字段。业务结构在 Agent 内维护，文档不复制 Schema 字段与默认值。
