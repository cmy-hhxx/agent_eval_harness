# 可编排评测 Host

通用 JSON 任务由 Host 编排，Agent 通过独立 Profile 定义提示词和输出 Schema。当前内置 Comparison 与 Attribution Profile，Comparison Workflow 负责分组对比、盲测和组合。默认使用 Pi，保留 Prime；Python 用于代码工具与 Prime runtime。

**项目处于快速迭代阶段，暂不设置版本号，也不维护向后兼容。** 修改接口或契约时同步更新实现、调用方、测试和文档。

## 快速开始

```bash
mise trust
mise install
cp .env.example .env
```

在 `.env` 填写两种底座共用的 `EVAL_BASE_URL` 和 `EVAL_API_KEY`。随后安装和构建：

```bash
npm run bootstrap
npm run build
npm run doctor
```

输入路径与输出目录都由配置接口指定，不依赖目录命名。`inputs.versions[].sources` 用 `file`（单文件）或 `directory`（递归按 `include` 的 basename 匹配，缺省全部 `*.jsonl`）描述每个版本的来源，日期子目录仅作整理。评测模型同样通过配置注入，不入库：在 [configs/host.json](configs/host.json) 核对输入与输出，复制 [configs/models.example.json](configs/models.example.json) 为 `configs/local/models.json` 并填入网关模型 ID，然后组合两个配置运行：

```bash
npm run eval -- preflight
npm run eval -- run --engine pi --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json
```

需要临时替换来源或输出时用 `--input <版本 ID>=<路径>`（目录或文件，可重复）和 `--output <目录>` 覆盖配置，不必改动入库文件。

结果位于 `<output.path>/<run-id>/`（默认 `data/runs/comparison/<run-id>/`）。重复使用同一个 `--run-id` 自动续跑，已接受任务始终保留，只评原选择范围内未完成和新增任务；源文件被追加或整理不会阻止续跑，未完成任务使用最新有效输入。参与对比的版本组合由配置的 `comparisons` 分组声明，可任意扩展（如 DeepSeek、Kimi），组内候选在同一次判断中排名，候选盲测后恢复稳定版本 ID。恢复规则、`--debug` 和结果文件说明见[使用指南](docs/usage.md#运行与恢复)。

错误日志写入 `log/runtime.log`，规整后的已接受评测结果逐行追加到 `log/evaluation.log`；目录不入库。日志去重、并行写入和查看方法见[日志说明](docs/usage.md#日志)。

## 文档

| 想了解什么 | 入口 |
|---|---|
| 配置、命令、目录、恢复与 Worker | [使用指南](docs/usage.md) |
| 输入、对比、结果与证据规则 | [数据契约](docs/contract.md)；[Schema 模块](schemas/README.md) |
| Host / Worker、模块边界与扩展 | [架构](docs/architecture.md)、[模块地图](docs/modules/README.md) |
| 开发、测试、依赖与文档维护 | [开发指南](docs/development.md) |
| 评语写法与真实模型人工复核 | [评测质量](docs/quality.md) |

固定工具版本见 [mise.toml](mise.toml)，底座版本和来源见 [vendor/upstream.json](vendor/upstream.json)。开发者与 Agent 的仓库约束见 [AGENTS.md](AGENTS.md)。
