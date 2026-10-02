# 可编排评测 Host

TypeScript Host 编排通用 JSON 评测，Agent 通过 Profile 提供提示词、Schema 和业务校验。当前内置 Criteria、Attribution、Comparison、Rewrite、Clustering 与 Comparison Workflow；默认使用 Pi，保留 Prime，Python 只用于代码工具和 Prime runtime。

**当前契约优先：**项目快速迭代，不设置未确定的版本号；结果只记录显式声明的 `evaluatorVersion`，用于区分不同评测器产出的判词，不是 Schema 版本。契约变更必须同步当前实现、调用方、测试和文档；详细规则见 [AGENTS.md](AGENTS.md)。

## Agent 开发导航

| 任务 | 先读 |
|---|---|
| 运行、配置、恢复、产物 | [使用指南](docs/usage.md) |
| 输入、Agent 输出、证据、导出 | [数据契约](docs/contract.md) · [Schema](schemas/README.md) |
| 提示词、工具描述与专家示例启用边界 | [提示词模块](packages/prompts/README.md) |
| 模块边界、Host / Worker、扩展 | [架构](docs/architecture.md) · [模块地图](docs/modules/README.md) |
| 修改、验证、测试和文档 | [开发指南](docs/development.md) |
| 评语和真实模型复核 | [评测质量](docs/quality.md) |
| 小批放量、失败补跑、逐格修复与交付核验 | [运行流程](docs/usage.md#运行与恢复) · [改写放量验收](docs/quality.md#改写放量验收) |
| 远程输入数据服务交接 | [输入服务交接](docs/handoff.md) |
| `bash automation.sh` 启动持续取数、评测改写与动态看板 | [Automations 流水线](docs/automations.md) |

阅读顺序：先看本页和 [AGENTS.md](AGENTS.md)，再按任务进入上表对应文档。使用步骤、数据语义、质量复核与实现边界分别以使用指南、数据契约、评测质量、架构及模块地图为准；规则只维护一份，其他页面通过链接引用。

## Eris 评测助手

配置根目录 `.env` 后运行 `bash agent/run.sh`，浏览器会打开浅色 Eris 评测助手。支持 `--port`、`--user`、`--no-open`；对话、独立 Attribution / Comparison 调用、原始数据引用与多副本恢复见 [Agent 使用说明](agent/README.md)。看板仍使用根目录 `bash run.sh`。

## 离线评测汇报

开发预览打开 [evaluation-report/index.html](evaluation-report/index.html)。流程、判决规则、提示词、实验各为一个主题页，页内重点直接展开，无嵌套切换或折叠。流程以真实的银河证券利率题贯穿共同标准、两条证据材料泳道、匿名比较与判决，支持关联高亮、局部放大和 A/B 换位；换位只改变代号，获胜来源仍是回答②（B组Expert）。本条结果来自 `eval-20261002-r68-quality`，实际评测器为 r69；与报告原有 r65 提示词快照、实验页 r64 聚合数据分别标明来源。复核、归类与润色呈现通用流程，不虚构本例执行记录。案例内容、图形、样式和交互在 [evaluation-report](evaluation-report/README.md) 内分开维护，不接入业务运行时。

执行 `node evaluation-report/build.mjs` 合并为 [evaluation-report/report.html](evaluation-report/report.html)，可单文件离线展示，页面不提供 HTML 导出按钮。完整提示词原文可下载为 TXT；浏览器打印只输出当前主题。

内容是人工核对的静态快照；工程测试不能代替真实裁判效果。更新时同步核对版本、来源、分母和复核状态，不修改原始结果或生产统计契约。

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

输入来源由 `configs/host.json` 的 `inputs.versions[].sources` 指定，支持单文件或递归目录；默认分为 A组Fast vs B组Fast、A组Expert vs B组Expert 两组；`comparisons` 每组选择二至三个模型，三模型执行三场两两比较；第三方基线须显式声明与组内一致的 `comparison_tier`，不能混排 Fast 与 Expert。需要临时替换来源或输出时使用 `--input <版本 ID>=<路径>` 和 `--output <目录>`。按日期或名称组织的多模型文件可用 `eval index --dataset ...` 登记为评测集，再用 `preflight/run --dataset ...` 选择；索引只保存定位信息，完整消息仍留在源文件，详见[输入治理](docs/usage.md#输入治理)。不要修改入库的原始输入、评测结果或 `dist/`。

固定工具版本见 [mise.toml](mise.toml)，底座版本与来源见 [vendor/upstream.json](vendor/upstream.json)。
