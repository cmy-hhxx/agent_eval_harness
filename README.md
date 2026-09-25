# 可编排评测 Host

通用 JSON 任务由 Host 编排，Agent 通过独立 Profile 定义提示词和输出 Schema。当前内置 Comparison 与 Critique 的 correctness Profile，Pairwise Workflow 负责配对、盲测和组合。默认使用 Pi，保留 Prime；Python 用于代码工具与 Prime runtime。

**项目处于快速迭代阶段，暂不设置版本号，也不维护向后兼容。** 修改接口或契约时同步更新实现、调用方、测试和文档。

## 快速开始

```bash
mise trust
mise install
cp .env.example .env
```

在 `.env` 填写共用的 `EVAL_BASE_URL` 和 `EVAL_API_KEY`，两种底座使用同一组变量。随后安装和构建：

```bash
npm run bootstrap
npm run build
npm run doctor
```

将输入按日期放到 `data/sources/model-answers/0922/`、`data/sources/model-answers/0923/` 等目录。每个目录的文件名为 `a_fast.jsonl`、`a_expert.jsonl`、`aa_fast.jsonl`、`aa_expert.jsonl`，不同日期沿用这组文件名；在 [configs/host.json](configs/host.json) 核对输入路径与裁判模型：

```bash
npm run eval -- preflight
npm run eval -- run --engine pi --run-id pi-001
npm run eval -- run --engine prime --run-id prime-001
```

结果位于 `data/runs/pairwise/<run-id>/`。重复使用同一个 `--run-id` 自动续跑，已接受任务始终保留，只评原选择范围内未完成和新增任务。只比较 Fast ↔ Fast、Expert ↔ Expert，候选盲测后恢复稳定版本 ID。恢复规则、`--debug` 和结果文件说明见[使用指南](docs/usage.md#运行与恢复)。

错误日志写入 `log/runtime.log`，规整后的已接受评测结果逐行追加到 `log/evaluation.log`；目录不入库。日志去重、并行写入和查看方法见[日志说明](docs/usage.md#日志)。

## 文档

| 想了解什么 | 入口 |
|---|---|
| 配置、命令、目录、恢复与 Worker | [使用指南](docs/usage.md) |
| 输入、配对、结果与证据规则 | [数据契约](docs/contract.md) |
| Host / Worker、模块边界与扩展 | [架构](docs/architecture.md)、[模块地图](docs/modules/README.md) |
| 开发、测试、依赖与文档维护 | [开发指南](docs/development.md) |
| 评语写法与真实模型人工复核 | [评测质量](docs/quality.md) |

固定工具版本见 [mise.toml](mise.toml)，底座版本和来源见 [vendor/upstream.json](vendor/upstream.json)。开发者与 Agent 的仓库约束见 [AGENTS.md](AGENTS.md)。
