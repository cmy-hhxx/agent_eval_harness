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

开发预览打开 [evaluation-report/index.html](evaluation-report/index.html)。流程页展示 `eval-20261003-002216` 中 r73 的 10 个真实案例，包含 3 道客观题、7 道主观题。完整问句、验收清单、独立核验、逐项优劣与原判取舍直接展示在同一机制图；69 条正式比较归并为 60 行有来源的图内摘要，区分优势、专属约束、待核实项和已知疑点。支持下拉选择、前后翻页、连线高亮和仅改变代号的 A/B 交换，没有缩放或浮层。底部按 A/B 展示真实问题归因的组件与问题名称，保留待核实状态。判决规则使用完整决策树，提示词的关键摘录与 28 份原文通过七个入口阅读。实验页仅保留空结构，尚未启动新的对比实验。

源码、内容、样式和交互在 [evaluation-report](evaluation-report/README.md) 内独立维护。执行 `node evaluation-report/build.mjs` 将 4 份 CSS 和 8 份 JS 内联为 [evaluation-report/report.html](evaluation-report/report.html)，可单文件离线展示；页面不提供下载或导出入口，不在运行时读取业务文件。

案例保留 r73 已接受评测记录的静态快照，不保证全部语义判断正确；提示词阅读器对应当前 r74。具体来源与已发现的案例问题见模块文档；更新时核对原始记录，不修改生产统计契约、输入或正式结果。

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
