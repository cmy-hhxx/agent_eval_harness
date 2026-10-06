# 开发指南

[返回首页](../README.md) · [仓库规则](../AGENTS.md) · [模块地图](modules/README.md)

## 修改路径

先读 README 与 AGENTS.md，再按任务进入下表。行为变化同步实现、当前调用方、测试和文档；删除被替代入口。模块依赖由架构测试检查，评测语义由阶段测试和真实样本复核。

| 修改内容 | 源码入口 | 核对内容 |
|---|---|---|
| 提示词、材料文案、工具描述 | [Prompts](../packages/prompts/README.md) | 实际发送文本、工具覆盖、评测器标识 |
| Agent 业务校验 | `packages/agents/src/<agent>/` | 请求、提交、正式结果及同目录测试 |
| Schema | [schemas/](../schemas/README.md) | Profile、解析与校验、当前 fixture |
| 输入、盲测、组合、改写回填、报告 | `packages/workflows/src/comparison/` | 输入映射、依赖、结果与恢复 |
| 文件、锁、日志 | `packages/data/` | 持久化顺序、重复写入、恢复与竞态 |
| 调度、Worker、SDK | `packages/host/`、`packages/runtime/` | 提交、预算、断连、回收与双 SDK 回归 |
| CLI 与本机看板 | `apps/host/`、[PRODUCT.md](../PRODUCT.md) | 配置解析、读取投影、控制及界面 |
| Eris | [修改 Eris](../agent/README.md#修改-eris) | 会话、工具、网关模型与浏览器回归 |
| 安装、构建、依赖 | `scripts/`、锁文件 | 独立构建、doctor 与干净安装 |
| 离线汇报 | [evaluation-report/](../evaluation-report/README.md) | 静态快照、来源与独立构建 |

## 当前契约

不维护旧入口或旧格式。A / B 输入适配、Pi / Prime SDK 适配和同 run 续跑是当前功能，不能当作兼容代码删除。项目版本与冻结统计契约以 [AGENTS.md](../AGENTS.md#当前契约优先) 为准；影响判词的改动同步更新 [`evaluatorVersion`](contract.md#评测器版本标识)。纯文档修正、无行为变化的搬迁或未调用代码清理无需更新判词标识。

### 禁止项目哈希与兼容层

遵守 [AGENTS.md 的当前契约](../AGENTS.md#当前契约优先)：使用业务标识、持久化 UUID 和必要的结构、引用及读写竞态检查，不引入项目自有摘要、源码指纹、跨 run 结果缓存或旧格式转换。输入只留在源文件；状态和结果的保存边界见[运行产物](usage.md#运行产物)。

## 验证

| 时机 | 命令与范围 |
|---|---|
| 开发中 | `npm run typecheck`；`npm test`（包内单元、架构与脚本测试） |
| 提交前、契约或跨模块收尾 | `npm run test:full`，追加 Eris 单元与 Host 集成回归 |
| Worker / SDK 变化 | `npm run test:integration`，运行直接 SDK 与 Runtime 集成 |
| 安装、构建或依赖变化 | `node scripts/test-clean.mjs`；`npm run doctor` 检查本机运行环境 |
| Eris 上游、浏览器或性能变化 | [Agent 验证命令](../agent/README.md#验证) |
| 离线汇报变化 | [汇报模块验证](../evaluation-report/README.md#维护与构建) |

测试分组以 [scripts/test.mjs](../scripts/test.mjs) 和 [package.json](../package.json) 为准。`npm test`、`test:full`、`test:integration` 均先重建应用；构建前先确认没有活跃评测任务。`typecheck` 检查未使用的局部变量和参数，未调用导出还需搜索跨包引用、动态加载、回调和测试。

每轮收尾及契约或目录变更后，清理失效用例、旧字段和重复 fixture/helper；保留当前行为需要的测试，不删除真实输入、结果或缓存。模型提交 fixture 使用当前扁平载荷，见[归因提交](../tests/fixtures/attribution-submission.ts)与[对比提交](../tests/fixtures/comparison-submission.ts)；内部判断使用[判定 fixture](../tests/fixtures/attribution-judgment.ts)。独立核验 fixture 不得从上游 met/core/ranking 反推首查。Worker fixture 使用具名选项和有界等待，构造失败释放资源。

`test-clean` 只清理自己的临时 checkout。失败排查可加 `--debug` 保留临时目录及 `diagnostic.json`，记录复制、安装与构建阶段的文件状态。

## 构建与依赖

```bash
npm run bootstrap
npm run build
npm run build:pi
npm run build:prime
```

工具版本以 [mise.toml](../mise.toml) 为准。根 workspace、两套 vendor npm workspace 与 Prime Python runtime 分别使用锁文件和依赖树。公共代码工具使用不含第三方依赖的根 `.venv`；Prime 使用独立 Python 环境。修改 vendor 同步 [upstream.json](../vendor/upstream.json) 的 `local_changes` 并重建，不手改 `dist/`。

`build:app` 先在 `.runtime/` 编译 TypeScript 和复制资源，成功后逐文件替换 `dist/` 并清理陈旧文件；这一编译阶段失败不改变现有产物。随后单独构建 Eris 的 Runtime 桥接与 Web 资源。整个构建不是原子切换，后续失败可能留下已更新的部分产物，运行中的进程也可能混用新旧模块；应停止活跃任务后构建，再启动服务。实现见 [build-app.mjs](../scripts/build-app.mjs)、[build-agent.mjs](../scripts/build-agent.mjs) 和 [publishTree](../scripts/lib.mjs)。

Pi 仅保留应用注册的网关模型。`npm --prefix vendor/pi run check:sources` 按[源码检查配置](../vendor/pi/tsconfig.check-sources.json)验证当前源码和公开示例；上游 `check` 包含依赖已裁剪模型目录的测试，不能作为本项目回归入口。使用根 `test:full` 与 `test:integration` 验证应用行为。Prime 的应用构建不下载模型或 MCP 目录，Worker 和直接 SDK 测试均以 `PI_OFFLINE=1` 禁止自动刷新。

Eris 普通构建只使用本仓库的 [Deepseek 源码映射](../vendor/deepseek/sources.json)与[局部补丁](../vendor/deepseek/local.patch)。维护命令 `node scripts/vendor-deepseek.mjs <上游仓库>` 才读取外部源码；同步更新选定包的源码、测试及 `vendor/upstream.json`。不引入上游桌面或独立客户端构建。

## 文档维护

README 是唯一导航入口，各页面只维护自己的主题：使用指南写操作，数据契约写语义，架构写接口与生命周期，模块地图定位源码，PRODUCT 写界面规则，质量指南写验收方法。Eris、自动化和离线汇报维护各自使用说明，提示词与 Schema 直接链接唯一来源。

一件事实只解释一次，其他页面引用；默认值、支持类型和字段优先链接配置、Schema 或类型。行为变更同步检查命令、提示词、错误反馈、测试名称、文档链接和锚点。临时计划与验证日志放 `.artifacts/`，长期文档不记录某次测试数量、完成清单或无法维护的外部实现；历史由 Git 保存。历史展示快照须在所属模块标明来源和适用范围，不作为当前规则。
