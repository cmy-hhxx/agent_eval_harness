# 可编排评测 Host

TypeScript Host 编排评测任务，Pi / Prime Worker 执行模型与工具调用。主线为共同 Criteria → 单回答 Attribution → 两两 Comparison；改写默认开启，独立核验与聚类按需执行。

开发先读 [AGENTS.md](AGENTS.md)。当前行为以源码、配置和 Schema 为准。

## 远程工作台

生产入口只有 `workbench.sh`。服务器代码与运行数据分离：

- checkout：`/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/code`
- 持久目录：`/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime`
- 数据源：`/mnt/fin_bench/eval_data`
- 评测产物：`/mnt/fin_bench/eval_data/{source}/eval_output/`；日常、专项分别在 `0_daily_eval/`、`1_task_eval/<任务>/`，所有真实模型测试在 `test_eval/`，不得写到其他位置。
- 内部监听：工作台 `5001`；数据服务 `127.0.0.1:8081`；自动化看板 `127.0.0.1:4174`；运行实例看板 `127.0.0.1:4173`
- 外部映射：`http://117.50.195.94:3309/`
- 页面：`/` 单页工作台，Tabler 一级模块导航原位切换运行监控、数据与任务、评测运行、错误日志、聚类与问题库和流程定义；模块内定位、筛选与分页均在当前页面完成
- 默认进入数据与任务：创建日常或专项任务、发现压缩包批次、归属、清洗和查看逐条报告；wencai、AIME、ifind 独立于任务类型。清洗后可选择同一任务的批次预检并启动评测，运行页关联错误定位、定向重试与同 run 续跑。结果支持按任务、批次和运行选择范围、单文件查看与归档，聚类手动预检启动，展示已纳入和未完成回答，重复范围由服务端阻止。日常与专项均手动清洗；已登记来源在运行监控点击「运行」后才持续取数与评测。操作见[数据服务](server_dashboard_ths/README.md)。

首次部署由本地一次性执行：

```bash
WORKBENCH_ADMIN_PASSWORD='<管理员密码>' npm run deploy:workbench
```

部署脚本从现有 Git origin 建立 checkout，安装仓库锁定的工具链，并在 checkout 外创建不覆盖已有文件的运行配置。之后日常只需要：

```bash
ssh <eval_data_server>
cd /mnt/aigc_team/user_workspace/chenmingyang/eval_harness/code
tmux new -s workbench
bash workbench.sh
```

`workbench.sh` 不执行 `git pull`，不每次重装依赖，不 daemonize。首次缺少依赖或构建产物时执行 bootstrap/build；后续只构建过期产物。实例锁阻止重复启动，子服务异常按退避重启，配置错误、端口冲突或连续崩溃会停止整套服务。服务启动和重启只恢复界面，评测来源等待手动点击「运行」。

手动启动来源后，服务器侧每四小时生成统计记录并追加到 `runtime/log/comparison-statistics-log.jsonl`。本地只运行轻量 relay，不下载输入、运行状态或评测正文：

```bash
export WORKBENCH_SERVER_URL=http://117.50.195.94:3309
export WORKBENCH_RELAY_TOKEN='<工作台 relay token>'
npm run report:relay -- --once
```

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

在 `config.ini` 填写渠道地址与密钥，在 `configs/local/models.json` 填写网关模型 ID。底层 CLI 继续供开发和测试使用：

```bash
npm run eval -- preflight
npm run automations -- check
npm run automations -- run --once
```

容器、来源清单与恢复语义见[自动化](docs/automations.md)。工作台部署与故障排查见[远程部署](docs/deployment.md)。

## 按任务阅读

| 任务 | 文档 |
|---|---|
| 配置、输入、运行、恢复、产物 | [使用指南](docs/usage.md) |
| 远程工作台部署与运行 | [部署](docs/deployment.md) |
| 工作台流程、任务批次与异常处理 | [产品契约](docs/workbench.md) |
| 持续取数、评测、MongoDB 与统计 relay | [自动化](docs/automations.md) |
| 输入、阶段结果、判决与证据 | [数据契约](docs/contract.md) · [Schema](schemas/README.md) · [字段用途](docs/schema-fields.md) |
| 模块、生命周期与扩展 | [架构](docs/architecture.md) · [模块地图](docs/modules/README.md) |
| 修改、测试与文档维护 | [开发指南](docs/development.md) |
| 人工复核与评测实验 | [评测质量](docs/quality.md) |
| 提示词与工具描述 | [Prompts](packages/prompts/README.md) |
| 界面规则 | [PRODUCT.md](PRODUCT.md) |
| 同花顺数据服务 | [服务源码](server_dashboard_ths/README.md) |
| Eris 对话、数据与工具 | [Agent 说明](agent/README.md) |
| 离线汇报与历史快照 | [汇报模块](evaluation-report/README.md) |

本地开发仍可使用 `npm run eval -- dashboard` 和 `bash agent/run.sh`。
