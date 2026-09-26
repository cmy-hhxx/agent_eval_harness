# 仓库规则

- 先读 [README](README.md)，按问题进入对应文档；当前主线是 TypeScript Host 和 Pi / Prime Worker。
- 项目处于快速迭代阶段，未明确固定版本前不设置项目、状态、Schema、Profile 或内部协议版本号，不维护向后兼容。改契约时同步修改调用方、配置、测试和文档，直接删除被替代实现；不增加旧入口、别名、迁移层或静默降级。
- 同 run ID 自动续跑、A / AA 输入适配、Pi / Prime SDK 适配属于当前功能，不能当作历史兼容删除。续跑不因代码、模型或参数变化而拒绝。
- Agent 提示词、业务校验与单元测试在 `packages/agents/src/<agent>` 维护；评测 Schema 集中在根目录 `schemas/<stage>/`，由对应 Agent 公开入口组装使用。Agent 之间禁止互相导入。归因 Agent 拥有归因树与问题库；组合、A/AA、盲测、状态编解码与报告属于 `packages/workflows/src/comparison`。
- 归因树是刻意的跨 run 知识库（非结果缓存）：每个模型一棵，按组件/工具大类归类问题，出现样本可双向追溯。库只追加、节点 ID 用持久化 UUID、合并保留 lineage；不哈希，不复制正式结果正文。归因 Agent 优先召回已有节点，禁止为同一现象重复造标签；对比 Agent 只确认，不新建节点。
- `apps/host` 负责 CLI、配置与组装；`packages/host` 接收 Agent、Workflow、Repository 定义，禁止导入具体业务。文件与锁属于 `packages/data`；Worker、HTTP/SSE、会话和双 SDK 属于 `packages/runtime`；通用工具只在 `packages/tools`。
- 跨包代码依赖只使用公开导出；根目录 `schemas/` 作为集中 JSON 资源模块由构建步骤复制，不视为代码依赖。Contracts 禁止文件、网络与 SDK 实现。模块依赖和验证入口见 `docs/modules/README.md`。
- Python 仅用于代码工具和 Prime SDK runtime；不要恢复独立 Python 评测器。
- 修改行为后运行 `npm run typecheck`、`npm test`；涉及 Worker / SDK 运行 `npm run test:integration`；涉及安装、构建或依赖还要运行 `node scripts/test-clean.mjs`。
- 文档职责与维护规则见 [开发指南](docs/development.md)。只保留当前事实，不增加已完成计划、历史操作指引或重复说明。
- 不编辑生成的 `dist`；不删除本地输入、评测结果和缓存来“清理代码”。
- 禁止交付压缩包；交付普通文件和目录。默认只用 `state.json` 保存续跑状态，额外排查文件仅在显式启用 `--debug` 后保留到 `_internal/`。
- 修改 vendor 必须更新 `vendor/upstream.json` 的 `local_changes` 并重新构建；Pi 仅注册应用从 `.env` 网关配置的模型，不恢复内置第三方模型数据和目录刷新。

- 禁止项目自有哈希计算、摘要校验、源码树指纹和跨 run 结果缓存；不得改用另一种摘要算法。第三方依赖内部机制和锁文件完整性字段保留。标识用持久化 UUID，已有 ID 原样保留。归因树是知识索引而非结果缓存，允许跨 run 累积。

- 原始输入只保留在数据源，不在每个 run 重复保存；同 run 已接受任务不因输入变化重评，只处理未完成和新增任务。`state.json` 只保存恢复所需索引、进度和草稿；已落盘的正式判决引用 JSONL，不重复保存正文。
- 应用日志统一写入根 `log/runtime.log` 和 `log/evaluation.log`，目录不入库。运行日志只记错误并限频；业务日志由 Host 在正式结果落盘后记录，按提交身份去重。Agent 不自行写日志，不新增日志文件或轮转文件；日志 IO 由 `packages/data` 维护。
