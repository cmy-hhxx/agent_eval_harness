# 开发指南

[返回首页](../README.md) · 模块和协议见[架构](architecture.md)。

## 不维护历史兼容

稳定前允许直接修改接口、配置、schema 和目录约定。修改时同步更新所有当前调用方、测试和文档，删除被替代实现。不要保留旧命令、旧配置别名、双写或静默降级。

两个输入适配器、两个 SDK adapter 和同 run ID 自动续跑都是当前功能。普通运行只读取当前状态格式；已有的 `upgrade-run` 是显式离线转换命令，不参与运行时恢复。状态格式与操作见[运行与恢复](usage.md#运行与恢复)。

Python 仅承担公共代码工具与 Prime SDK runtime；根 [pyproject.toml](../pyproject.toml) 定义代码工具的 Python 环境。上游源码、版本和来源由 [vendor/upstream.json](../vendor/upstream.json) 管理。

## 修改与验证

| 修改内容 | 入口 | 验证重点 |
|---|---|---|
| 输入、配对、证据、报告 | `packages/pairwise-eval` | 输入拒绝、A/B 映射、当前 schema、报告 |
| 公共工具 | `packages/tools` | 工具预算、产物、取消和进程回收 |
| 调度、收据、恢复 | `apps/host`、`packages/worker` | 重复提交、丢失确认、恢复和失败状态 |
| SDK 调用 | `packages/agent-pi`、`packages/agent-prime` | 真实 SDK 的本地模拟网关集成测试 |
| 安装、构建、依赖 | `scripts`、锁文件 | 独立构建、doctor、clean test |

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
node scripts/test-clean.mjs
```

行为修改必须通过 `typecheck` 和 `npm test`；涉及 Worker / SDK 时加跑 `test:integration`，涉及安装、构建或依赖时加跑 `test-clean`。`typecheck` 包含未使用局部变量和参数检查，但不能发现所有未被调用的导出；删除导出前还要检查跨模块引用、动态加载与 SDK 回调。`npm test` 重建应用后运行 Host 测试。`build:app` 先删除自己拥有的编译输出，避免已删除源码留下可执行文件。不要手改 `dist/`。

提示词在 [resources/prompts](../packages/pairwise-eval/resources/prompts/) 的 Markdown 文件中维护，启动时读取。不计算提示词或源码摘要；debug 模式额外保存本次启动的契约快照及各 attempt 的实际提示词。效果验证见[评测质量](quality.md#真实模型复核)。

SDK 集成测试使用真实 vendored SDK、独立 Worker、本地模拟网关和 Python 代码工具，不调用付费模型。测试直接验证当前行为，不从历史实现生成预期结果。真实裁判质量另按[质量指南](quality.md)人工复核。

`test-clean` 复制可入库文件到临时目录，仅共享下载缓存，在没有全局 Agent CLI、已安装依赖或原虚拟环境的环境中安装、分别构建两个 adapter、运行 doctor 和测试。npm 通过原安装路径调用，避免 mise 启动器在临时目录错误解析相对路径。它使用本地占位 URL 并清空模型密钥；集成测试自行设置模拟凭证，不读取个人 `.env` 或真实输入。

项目自有执行代码禁止哈希计算，不使用其他摘要算法替代。输入按业务标识登记 UUID，持久状态只引用源文件；已经接受的任务保持原结果；结构、引用、重复行和缺行检查仍须保留。第三方依赖内部机制和锁文件 integrity 不在此限制范围。

## 构建与依赖

```bash
npm run bootstrap
npm run build
npm run build --workspace @eval/agent-pi
npm run build --workspace @eval/agent-prime
```

工具版本以 [mise.toml](../mise.toml) 为准。根 workspace、两个 vendor 和两个 Python 环境分别使用锁文件；vendor 保持独立依赖树。更新上游时显式更新源码、锁文件、来源清单与构建 UUID，不在运行时自动升级。

修改 vendor 必须记录 `local_changes` 并重建。Pi 的离线模型数据及两种 SDK 构建记录说明见[底座源码开发](architecture.md#底座源码开发)。

## 文档维护

README 是唯一入口，正文统一放在 `docs/`，使用、契约、架构、开发、质量各一页。仅仓库执行规则保留在根 `AGENTS.md`。

- 一件事实只解释一次，其他页面链接它；schema、配置与类型直接链接源码。
- 行为变更与对应文档一起改，不留下失效命令或“以后兼容”的说明。
- 校对范围包含提示词、工具描述、错误修复提示和测试名称；这些内容也必须使用当前契约的字段与语义。
- 批次统计通过 preflight 获取，运行记录进入 `data/runs/`；临时计划和验证日志进入 `.artifacts/`。
- 完成的计划不作为长期手册保存，历史通过 Git 查阅，不新建 archive 文档树。
- 新增页面前先检查是否能放入已有五页；所有正文必须能从 README 到达。
