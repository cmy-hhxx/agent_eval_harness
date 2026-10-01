# 开发指南

[返回首页](../README.md) · 模块边界见[架构](architecture.md)和[模块地图](modules/README.md)。

## Agent 最短路径

1. 先读根目录 `AGENTS.md`，确认任务属于哪个模块。
2. 从下表进入唯一规则来源和源码入口；不要全量阅读无关文档。
3. 修改实现、当前调用方、测试和文档；删除被替代入口。
4. 跑对应验证，最后检查 `git diff`、失效链接和测试 fixture。

## 当前契约

项目处于快速迭代阶段，状态、结果 Schema、Profile 和内部协议不设置未确定的版本号，也不维护旧代码兼容；唯一评测器标识见[数据契约](contract.md#评测器版本标识)。契约变更直接更新当前实现：不保留旧命令、字段、配置别名、迁移层、双写、静默降级或旧格式测试。两个输入适配器、两个 SDK adapter 和同 run ID 续跑是当前功能，不属于历史兼容。

### 禁止项目哈希与兼容层

项目执行代码禁止新增没有必要的哈希、摘要、校验和、源码树指纹或跨 run 结果缓存；不要换用另一种摘要算法。用业务标识、持久化 UUID 以及必要的结构、引用、重复行、缺行和文件读写竞态检查完成校验。`evidence_id` 是可解析的证据坐标，不是哈希。第三方依赖内部机制和锁文件 `integrity` 字段不在此限制内。

不计算提示词或源码摘要；debug 保存本次启动的契约快照及 attempt 排查材料，清单见[运行产物](usage.md#运行产物)。输入只在源文件保留，状态只引用源文件和正式 JSONL；已经接受的任务不因输入变化重评。详见[数据契约](contract.md)和[运行与恢复](usage.md#运行与恢复)。

## 修改范围

| 修改内容 | 入口 | 验证重点 |
|---|---|---|
| Agent 规则、公共材料文案、工具描述 | `packages/prompts/resources/`，装配在 `packages/prompts/src/` | 实际模型文本、工具描述覆盖、评测判词 |
| Agent 业务校验、测试样例 | `packages/agents/src/<agent>` | Agent 契约、证据、判决 |
| 请求 / 提交 / 结果 Schema | 根目录 `schemas/<stage>/` | 对应 Profile、解析、校验和快照 |
| 输入适配、分组、盲测、报告 | `packages/workflows/src/comparison` | 注册表、映射、编解码、结果 |
| 本地存储、锁、日志 | `packages/data` | 原子保存、追加、恢复、并行写入 |
| 调度、收据、恢复 | `packages/host`、`packages/runtime` | 重复提交、断连、失败状态 |
| 独立分析助手 | `agent/src`、`apps/host/src/assistant-*`、`packages/runtime/src/assistant-*`、`packages/data/src/assistant-store.ts` | 会话追加、专业任务恢复、网关模型、浏览器回归；详见 [Agent 验证](../agent/README.md#验证) |
| 工具与 SDK | `packages/tools`、`packages/runtime/src/adapters` | 预算、回收、真实 SDK 集成 |
| 安装、构建、依赖 | `scripts`、锁文件 | 独立构建、doctor、干净安装 |

Agent 测试跟随 Agent 放置，集中提示词模块的测试在 `packages/prompts/src/`；跨模块和运行测试放在 `tests/`，共享 fixture 只保留仍被多个测试使用的最小集合。Schema 修改时同步检查 Profile `index.ts`、`validate.ts`、（如有）`resolve.ts`、[提示词](../packages/prompts/README.md)和测试样例。

## 验证

常用验证：

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
node scripts/test-clean.mjs
```

行为修改至少运行 `typecheck` 和 `npm test`；涉及 Worker / SDK 加跑 `test:integration`；涉及安装、构建或依赖加跑 `test-clean`。`typecheck` 会检查未使用的局部变量和参数，但不能发现所有未调用的导出；删除导出前搜索跨模块引用、动态加载和 SDK 回调。`npm test` 会重建应用并运行单元、架构和回归测试。

### 测试代码生命周期

每次契约或目录变更、每轮迭代收尾和提交前：

- 删除失效用例、旧字段断言、重复 fixture/helper 和旧兼容路径；
- 测试名称、样例和错误断言使用当前字段与语义；
- 只为当前行为保留测试，不为“以后兼容”预留用例；
- `test-clean` 只清理临时构建目录，不删除真实输入、结果、缓存或运行数据。

## 构建与依赖

```bash
npm run bootstrap
npm run build
npm run build:pi
npm run build:prime
```

工具版本以 [mise.toml](../mise.toml) 为准。根 workspace、两个 vendor npm workspace 和 Prime Python runtime 使用各自锁文件；vendor 保持独立依赖树。修改 vendor 必须同步 `vendor/upstream.json` 的 `local_changes` 并重建，不在运行时自动升级。不要手改 `dist/`。`build:app` 会移除并重建部分 `dist/`；在共享工作目录中构建前先停止活跃 Host / Worker，避免破坏在途任务加载的入口。

Pi 仅保留应用显式注册的网关模型。`npm --prefix vendor/pi run check:sources` 使用 [源码检查配置](../vendor/pi/tsconfig.check-sources.json) 验证裁剪后的 TypeScript 实现和公开示例；功能回归使用根目录的 `npm test` 和 `npm run test:integration`。原上游 `check` 命令仍包含依赖内建模型目录的测试类型检查，这些测试依赖的模型数据已被裁剪；`check:sources` 不运行或验证这些测试。

Python 只承担公共代码工具和 Prime SDK runtime；[bootstrap](../scripts/bootstrap.mjs) 创建不含第三方依赖的代码工具环境，Prime 使用独立项目和锁文件。

Prime 的应用 SDK 构建不下载或生成模型 / MCP 目录资产，保留上游编译内置数据并使用应用显式注册的网关模型。Worker 设置 `PI_OFFLINE=1`，关闭上游目录自动刷新；直接 SDK 集成测试使用相同设置。

## 文档维护

README 是唯一入口；正文按使用、契约、架构、开发、质量和模块地图分工。新增页面前先检查能否放入现有页面，正文必须能从 README 到达。

- 一件事实只解释一次，其他页面链接唯一来源；Schema、配置和类型直接链接源码。
- 先给结论和最短操作，再按需要展开细节；不要把实现历史、完成计划或重复字段表写进长期文档。
- 行为变更与文档同步；校对提示词、工具描述、错误修复提示、测试名称和 Schema 字段。
- 临时计划和验证日志放 `.artifacts/`；长期文档不要链接未入库的本机文件或把某次测试数量当现状。历史通过 Git 查阅，不建立 archive 文档树。

## 独立分析 Agent 验证

总 Agent 的上游回归、浏览器、视觉与性能命令见 [Agent 验证](../agent/README.md#验证)。`build:app` 同时编译 Runtime 的上游桥接与 Web 资源；不需要相邻的 Deepseek 仓库，也不运行上游桌面或客户端构建。源代码移植维护使用 `scripts/vendor-deepseek.mjs`，替换所选包的源码和测试，局部修改集中记录在 `vendor/deepseek/local.patch` 和 `vendor/upstream.json`。产品交付与运行环境见 [Agent 说明](../agent/README.md)。

上游回归覆盖实际装配的 Web 组件和共享会话、传输协议；新增运行状态、模型选择、菜单或排队行为时同步更新测试入口。性能 adapter 只替换服务、存储和浏览器环境，保留上游负载、测量和预算。干净安装验证使用临时 checkout；上游、浏览器和性能检查通过独立命令运行。
