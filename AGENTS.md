# 仓库规则

## 开始任务

1. 先读 [README](README.md)，再按任务进入对应文档；主线是 TypeScript Host 和 Pi / Prime Worker。
2. 修改行为时同步更新实现、当前调用方、测试和文档；只保留当前事实，不保留历史计划或重复说明。
3. 不编辑生成的 `dist/`，不删除本地输入、评测结果或缓存来“清理代码”。

## 当前契约优先

- **统计上传日志结构已冻结**：以 [`schemas/workflow/statistics-log.schema.json`](schemas/workflow/statistics-log.schema.json) 为固定契约，包括所有 `wins` 同级的 `both_good / both_bad` 对战计数。后续仅更新统计值、标签内容和日期条目；禁止自行增删、重命名字段或改变类型、层级。落盘与上传（包括续传）必须校验，不能静默转换。只有用户明确要求修改这份外部契约时才能变更；普通看板、统计或自动化改动不构成授权。
- 项目快速迭代，未明确固定版本前不设置项目、状态、Schema、Profile 或内部协议版本号。`evaluatorVersion` 是唯一例外：它是显式声明、人工维护的评测器标识，用于结果溯源，不是 Schema 或内部协议版本，不引入兼容分支。任何影响判词的变更（提示词、业务校验、材料组装、证据解析、判决与导出逻辑、聚类硬约束）都必须同步更新它。
- **禁止兼容旧代码或旧契约**：直接更新当前调用方并删除旧入口、别名、迁移层、双写和静默降级；不要为旧格式保留测试。
- 同 run ID 续跑、A / B 输入适配、Pi / Prime SDK 适配是当前功能，不得误删；续跑不因代码、模型或参数变化而拒绝。
- 禁止项目自有且没有必要的哈希、摘要、校验和、源码树指纹或跨 run 结果缓存。使用业务标识和持久化 UUID；保留必要的结构、引用、重复行、缺行和文件读写竞态检查。`evidence_id` 是可解析的证据坐标，不是哈希。第三方依赖内部机制及锁文件 `integrity` 字段不受此限制。

## 模块边界

- 所有内置 Agent 的提示词、共用材料文案和工具描述集中在 [`packages/prompts`](packages/prompts/README.md)；业务校验和单元测试在 `packages/agents/src/<agent>`；Schema 集中在根目录 `schemas/<stage>/`，由 Agent 公开入口组装。Agent 之间禁止互相导入。
- Attribution Agent 只输出每条回答的归因结果和问题描述（component/label/definition），不读问题库、不建类；Clustering Agent 拥有问题库，负责归类、新建类和合并类。Comparison 只确认既有 finding，不改写归因结论。改写 Agent 只接收待润色的文本槽位，不接触证据，也不能改动判决；槽位映射、回填与 commentary 属于 `packages/workflows/src/comparison`。组合、A/B、盲测、状态编解码和报告也属于该 Workflow。
- `apps/host` 负责 CLI、配置和组装；`packages/host` 只接收定义，禁止导入具体业务。文件、锁和日志属于 `packages/data`；Worker、HTTP/SSE、会话和双 SDK 属于 `packages/runtime`；通用工具只在 `packages/tools`。
- 本机看板只呈现数据、状态和错误，不写解释性、占位或使用说明式小字；界面文案与视觉规则见 [PRODUCT.md](PRODUCT.md)。
- 跨包代码只使用公开导出；根目录 `schemas/` 是由构建复制的 JSON 资源，不是代码依赖。Contracts 禁止文件、网络和 SDK 实现。边界与验证入口见 [模块地图](docs/modules/README.md)。
- Python 只用于代码工具和 Prime SDK runtime；不要恢复独立 Python 评测器。

## 数据与运行

- 原始输入只保留在数据源，不在每个 run 重复保存。`state.json` 只保存恢复所需索引、进度和草稿；正式结果引用 JSONL，不重复保存正文。
- 问题库是跨 run 知识库，不是结果缓存：每个模型一份，类 ID 用持久化 UUID，出现样本与事件追加；合并会更新类状态和样本归属，保留 lineage；类数量由程序硬控（每模型上限 + 单次新增预算 + 合并整理），不复制正式结果正文。
- 默认保存恢复状态、正式结果与报告，不归档排查材料；排查材料只有显式 `--debug` 才写入 `_internal/`。产物清单见[使用指南](docs/usage.md#运行产物)，禁止交付压缩包。
- 运行与评测日志统一写入根 `log/runtime.log` 和 `log/evaluation.log`；Agent 不自行写日志、不新增日志文件或轮转文件。自动化的统计交付记录另写 `log/comparison-statistics-log.jsonl`，不是运行日志；日志 IO 均由 `packages/data` 维护。

## 验证与维护

- 开发中运行 `npm run typecheck`、`npm test`（单元、架构与脚本）；提交前和契约变更运行 `npm run test:full`（追加 Agent 与 Host 集成回归）；涉及 Worker / SDK 加跑 `npm run test:integration`；涉及安装、构建或依赖加跑 `node scripts/test-clean.mjs`。
- 每次契约或目录变更、每轮迭代收尾和提交前检查测试代码：删除失效用例、旧字段、重复 fixture/helper 和旧兼容路径，让测试只覆盖当前行为。不要删除真实输入、结果或缓存来“清理测试”。
- 修改 vendor 必须更新 `vendor/upstream.json` 的 `local_changes` 并重新构建。Pi 只注册应用从 `.env` 网关配置的模型，不恢复内置第三方模型数据或目录刷新。
