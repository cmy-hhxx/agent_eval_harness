# 开发指南

[返回首页](../README.md) · 模块和协议见[架构](architecture.md)。

## 不维护历史兼容

稳定前允许直接修改接口、配置、schema 和目录约定。修改时同步更新所有当前调用方、测试和文档，删除被替代实现。不要保留旧命令、旧配置别名、双写或静默降级。

两个输入适配器、两个 SDK adapter 和同 run ID 自动续跑都是当前功能。只维护当前状态结构，不保留旧格式转换入口。状态格式与操作见[运行与恢复](usage.md#运行与恢复)。

Python 仅承担公共代码工具与 Prime SDK runtime；[bootstrap](../scripts/bootstrap.mjs) 创建不含第三方依赖的代码工具虚拟环境，Prime 使用其独立的项目与锁文件。上游源码、版本和来源由 [vendor/upstream.json](../vendor/upstream.json) 管理。

## 修改与验证

| 修改内容 | 入口 | 验证重点 |
|---|---|---|
| Agent 提示词、Schema、判决 | `packages/agents/src/<agent>`、根目录 `schemas/<stage>/` | 独立运行、契约、证据与判决 |
| 输入适配、分组对比、盲测、报告 | `packages/workflows/src/comparison` | 适配器注册表、A/B 映射、结果编解码 |
| 本地存储 | `packages/data` | 原子保存、追加失败、锁、崩溃恢复 |
| 公共工具 | `packages/tools` | 工具预算、产物、取消和进程回收 |
| 调度、收据、恢复 | `packages/host`、`packages/runtime` | 重复提交、丢失确认、恢复和失败状态 |
| SDK 调用 | `packages/runtime/src/adapters` | 真实 SDK 的本地模拟网关集成测试 |
| 安装、构建、依赖 | `scripts`、锁文件 | 独立构建、doctor、clean test |

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
node scripts/test-clean.mjs
```

行为修改必须通过 `typecheck` 和 `npm test`；涉及 Worker / SDK 时加跑 `test:integration`，涉及安装、构建或依赖时加跑 `test-clean`。`typecheck` 包含未使用局部变量和参数检查，但不能发现所有未被调用的导出；删除导出前还要检查跨模块引用、动态加载与 SDK 回调。`npm test` 重建后运行模块内单元测试、架构测试和跨模块回归；`test:integration` 运行双 SDK 网关集成与通用 JSON 并行隔离。`build:app` 先删除自己拥有的编译输出，避免已删除源码留下可执行文件。不要手改 `dist/`。

提示词、业务校验、样例和单元测试按 Agent 集中维护；请求/提交/结果 Schema 统一放在根目录的 [schemas 模块](../schemas/README.md)，见[模块地图](modules/README.md)和[数据契约的分层说明](contract.md#输入与输出的分层)。提示词与 Schema 构建时复制到编译目录，运行时按模块位置读取。不计算提示词或源码摘要；debug 模式额外保存本次启动的契约快照及各 attempt 的实际提示词。效果验证见[评测质量](quality.md#真实模型复核)。

SDK 集成测试使用真实 vendored SDK、独立 Worker、本地模拟网关和 Python 代码工具，不调用付费模型。测试直接验证当前行为，不从历史实现生成预期结果。真实裁判质量另按[质量指南](quality.md)人工复核。

`test-clean` 复制可入库文件到临时目录，仅共享下载缓存，在没有全局 Agent CLI、已安装依赖或原虚拟环境的环境中安装、分别构建两个 adapter、运行 doctor 和测试。npm 通过原安装路径调用，避免 mise 启动器在临时目录错误解析相对路径。它使用本地占位 URL 并清空模型密钥；集成测试自行设置模拟凭证，不读取个人 `.env` 或真实输入。

项目自有执行代码禁止哈希计算，不使用其他摘要算法替代。输入按业务标识登记 UUID，持久状态只引用源文件；已经接受的任务保持原结果；结构、引用、重复行和缺行检查仍须保留。第三方依赖内部机制和锁文件 integrity 不在此限制范围。

## 构建与依赖

```bash
npm run bootstrap
npm run build
npm run build:pi
npm run build:prime
```

工具版本以 [mise.toml](../mise.toml) 为准。根 npm workspace、两个 vendor npm workspace 和 Prime Python runtime 分别使用锁文件；vendor 保持独立依赖树。公共代码工具只使用 Python 标准库，不声明虚构的项目版本。更新上游时显式更新源码、锁文件、来源清单与构建 UUID，不在运行时自动升级。

修改 vendor 必须记录 `local_changes` 并重建。Pi 的网关模型注册及两种 SDK 构建记录说明见[底座源码开发](architecture.md#底座源码开发)。

## 文档维护

README 是唯一入口，正文统一放在 `docs/`，使用、契约、架构、开发、质量各一页；具体模块说明集中在 `docs/modules/README.md`。仅仓库执行规则保留在根 `AGENTS.md`。

- 一件事实只解释一次，其他页面链接它；schema、配置与类型直接链接源码。
- 行为变更与对应文档一起改，不留下失效命令或“以后兼容”的说明。
- 校对范围包含提示词、工具描述、错误修复提示和测试名称；这些内容也必须使用当前契约的字段与语义。
- 批次统计通过 preflight 获取，运行记录进入 `data/runs/comparison/`；临时计划和验证日志进入 `.artifacts/`。
- 完成的计划不作为长期手册保存，历史通过 Git 查阅，不新建 archive 文档树。
- 新增页面前先检查是否能放入已有五页；所有正文必须能从 README 到达。
