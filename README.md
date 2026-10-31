# 可编排评测 Host

TypeScript Host 编排评测任务，Pi Worker 执行模型与工具调用。通过 CLI 显式选择输入、启动与续跑评测；Eris 提供已有结果的只读分析。

评测能力包括 Criteria、Attribution、指令遵循归因、Score、Comparison、Clustering 和 Rewrite。Attribution 按 compact → 组件并行调查 → trace 摘要 → session 归因流水线；Comparison 对整场 session 做两两比较。开发先读 [AGENTS.md](AGENTS.md)，当前行为以源码、配置和 Schema 为准。

## 运行边界

评测服务与 Eris 均在服务器运行；本地只做代码开发、构建、模拟测试和 Git 提交推送。服务器拉取代码后安装、构建并启动服务，真实数据与评测产物留在服务器。

服务器代码统一部署在 `/mnt/fin_bench/sync_datasets/code/1_eval_harnes/` 下：主线为 `main/`，Eris 为 `eris-code/`，其他分支或用途使用独立子目录；持久运行目录为 `runtime/`。不再向 `user_workspace` 部署代码或运行脚本，完整约定见[部署目录](docs/deployment.md#目录)。

输入由仓库外准备，Host 接收显式配置的文件或目录，通过 CLI 预检、执行、续跑并保存正式结果。显式批次入口统一网关额度、Worker 池和多路完成接力；配置见[批次调度](docs/usage.md#批次调度)。收包清洗、网页工作台、目录监控、日夜定时触发、MongoDB 同步和统计上传不在本仓库的运行链路中。

服务器数据工作重点是各来源的 `2_eval_input/`、`3_eval_output/` 和 `4_user_kyc_data/`；默认不查看 `0_archive/`、`1_7z_data/`。完整目录及配置方式见[服务器数据目录](docs/deployment.md#服务器数据目录)，业务路径和来源清单只在外部配置中声明。

Eris 读取已有产物：Comparison 的结构化统计与案例使用运行查询，独立 Attribution 结果及历史快照使用公开资产查询。各次运行可能包含重复样本，统计不能直接相加。Score 保留独立 Agent 契约，尚未接入 session workflow。

Compact、Attribution、Comparison 和可选独立核验共用原始来源坐标与引用解析；摘要导航和正式引文的边界见[数据契约](docs/contract.md)。使用方式见下文。

## 本地开发

```bash
mise trust
mise install
cp config.example.ini config.ini
mkdir -p configs/local
cp configs/models.example.json configs/local/models.json
npm run bootstrap
npm run build
npm run doctor
```

在 `config.ini` 填写渠道地址与密钥，在 `configs/local/models.json` 填写网关模型 ID。输入、输出和阶段配置以 [host.json](configs/host.json) 为基底，通过 `--config` 顺序覆盖。

```bash
npm run typecheck
npm test
```

真实评测在服务器按[使用指南](docs/usage.md#最短路径)预检、启动和续跑。同 run ID 续跑保留已接受结果和累计预算；新 run 也先检查已有正式结果，完整成功的同一回答跨评测器版本复用。默认交付按被评模型分目录、业务日期命名文件，run 仅用于内部恢复与溯源，详见[目录约定](docs/usage.md#目录约定)。产物约定写入 `/mnt/fin_bench/eval_data/{source}/3_eval_output/`：日常在 `0_daily_eval/`，流失在 `3_lost_user_eval/`，专项在 `1_task_eval/<任务>/`，小样本与验证在 `test_eval/`。原始输入保留在数据源，不随 run 复制；具体位置由[目录配置](docs/deployment.md#目录配置)指定。

## Eris

Eris 保留聊天、账户、模型选择、结果与证据读取、搜索和图表。服务器启动入口：

```bash
bash agent/run.sh --config /absolute/path/eris.json
```

服务器地址为 `http://117.50.195.94:3928`，内部端口 `5004`。部署、账号与恢复见 [Eris](agent/README.md) 和[部署指南](docs/deployment.md)。本机只进行开发与模拟验证。

## 按任务阅读

| 任务 | 文档 |
|---|---|
| 配置、输入、运行、恢复、产物 | [使用指南](docs/usage.md) |
| 服务器目录、部署与启动 | [部署指南](docs/deployment.md) |
| 输入、判决与证据 | [数据契约](docs/contract.md) · [Schema](schemas/README.md) · [字段用途](docs/schema-fields.md) |
| 模块、生命周期与扩展 | [架构](docs/architecture.md) · [模块地图](docs/modules/README.md) |
| 修改、测试与文档维护 | [开发指南](docs/development.md) |
| 单回答评分与归因 | [独立回答评测](docs/answer-review.md) |
| Session 归因与正式结果 | [Attribution](docs/attribution.md) |
| AIME 显式输入评测 | [AIME 评测](docs/aime-incremental.md) |
| 人工复核与稳定性验证 | [评测质量](docs/quality.md) |
| 提示词与工具描述 | [Prompts](packages/prompts/README.md) |
| Eris 产品与界面规则 | [PRODUCT.md](PRODUCT.md) |
| 历史报告、研究与数据快照 | [历史材料](evaluation-report/README.md) |
