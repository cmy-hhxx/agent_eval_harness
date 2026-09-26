# 可编排评测 Host

TypeScript Host 编排通用 JSON 评测，Agent 通过 Profile 提供提示词、Schema 和业务校验。当前内置 Attribution、Comparison、Rewrite、Clustering 与 Comparison Workflow；默认使用 Pi，保留 Prime，Python 只用于代码工具和 Prime runtime。

**当前契约优先：**项目快速迭代，不设置未确定的版本号，不兼容旧代码。契约变更必须同步当前实现、调用方、测试和文档；详细规则见 [AGENTS.md](AGENTS.md)。

## Agent 开发导航

| 任务 | 先读 |
|---|---|
| 运行、配置、恢复、产物 | [使用指南](docs/usage.md) |
| 输入、Agent 输出、证据、导出 | [数据契约](docs/contract.md) · [Schema](schemas/README.md) |
| 模块边界、Host / Worker、扩展 | [架构](docs/architecture.md) · [模块地图](docs/modules/README.md) |
| 修改、验证、测试和文档 | [开发指南](docs/development.md) |
| 评语和真实模型复核 | [评测质量](docs/quality.md) |

阅读顺序：先看本页和 `AGENTS.md`；定位任务后只打开对应文档和源码入口。规则只维护一份，其他页面通过链接引用。

## 最短运行路径

```bash
mise trust
mise install
cp .env.example .env
npm run bootstrap
npm run build
npm run doctor
```

在 `.env` 填写两种底座共用的 `EVAL_BASE_URL` 和 `EVAL_API_KEY`。将 [configs/models.example.json](configs/models.example.json) 复制为 `configs/local/models.json`，填入网关模型 ID，然后运行：

```bash
npm run eval -- preflight
npm run eval -- run --engine pi --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json
```

默认结果写入 `data/runs/comparison/<run-id>/`，日志写入 `log/runtime.log` 和 `log/evaluation.log`。同一个 `run-id` 会续跑未完成和新增任务，并保留已接受任务；输入、选择、模型和恢复细节见[使用指南](docs/usage.md#运行与恢复)。需要按样本查看输入、正式输出和 Agent 状态，或在页面预检并启动运行，在项目根目录执行 `bash run.sh`；详情见[本机看板](docs/usage.md#本机运行看板)。

输入来源由 `configs/host.json` 的 `inputs.versions[].sources` 指定，支持单文件或递归目录；对比组由 `comparisons` 配置，不依赖目录命名。需要临时替换来源或输出时使用 `--input <版本 ID>=<路径>` 和 `--output <目录>`。不要修改入库的原始输入、评测结果或 `dist/`。

固定工具版本见 [mise.toml](mise.toml)，底座版本与来源见 [vendor/upstream.json](vendor/upstream.json)。
