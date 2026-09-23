# 仓库规则

- 先读 [README](README.md)，按问题进入对应文档；当前主线是 TypeScript Host 和 Pi / Prime Worker。
- 项目稳定前不维护向后兼容。改契约时同步修改调用方、配置、测试和文档，直接删除被替代实现；不增加旧入口、别名、迁移层或静默降级。
- 同版本恢复、A / AA 输入适配、Pi / Prime SDK 适配属于当前功能，不能当作历史兼容删除。
- 评测规则只在 `packages/pairwise-eval` 维护；通用工具只在 `packages/tools` 维护。不要复制到各底座。
- Python 仅用于代码工具和 Prime SDK runtime；不要恢复独立 Python 评测器。
- 修改行为后运行 `npm run typecheck`、`npm test`；涉及 Worker / SDK 运行 `npm run test:integration`；涉及安装、构建或依赖还要运行 `node scripts/test-clean.mjs`。
- 文档职责与维护规则见 [开发指南](docs/development.md)。只保留当前事实，不增加已完成计划、历史操作指引或重复说明。
- 不编辑生成的 `dist`；不删除本地输入、评测结果和缓存来“清理代码”。
- 修改 vendor 必须更新 `vendor/upstream.json` 的 `local_changes` 并重新构建；本次整理不涉及上游源码。
