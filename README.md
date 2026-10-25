# 可编排评测 Host

TypeScript Host 编排评测任务，Pi / Prime Worker 执行模型与工具调用。主线为共同 Criteria → 单回答 Attribution → 两两 Comparison；改写默认开启，独立核验与聚类按需执行。

开发先读 [AGENTS.md](AGENTS.md)。当前行为以源码、配置和 Schema 为准。

## 远程工作台

工作台入口为 `workbench.sh`，统一控制问财日常四路与 AIME 日常两阶段评测。服务器代码与运行数据分离：

- checkout：`/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/code`
- 持久目录：`/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime`
- 数据源：`/mnt/fin_bench/eval_data`
- 评测产物：`/mnt/fin_bench/eval_data/{source}/eval_output/`；日常、专项分别在 `0_daily_eval/`、`1_task_eval/<任务>/`，所有真实模型测试在 `test_eval/`，不得写到其他位置。
- 内部监听：工作台 `5001`；数据服务 `127.0.0.1:8081`；自动化看板 `127.0.0.1:4174`；运行实例看板 `127.0.0.1:4173`
- 外部映射：`http://117.50.195.94:3309/`
- 页面：`/` 单页工作台，一级入口为评测、数据、结果、更多；默认进入评测，问财和 AIME 同时可见、分别控制，可同时运行。
- 每个来源默认进入总览，用 Tabler 与 ECharts 展示全量数据分布、业务日期趋势和当前评测覆盖；包名、清洗报告及分页明细位于次级页签。
- 数据入口保留按日期并列 Fast／Expert 的表格、完整完成 ✅ 和原始问答分页；完成口径使用当前全量配对或两阶段正式收据。
- 问财收包：`0_wencai/1_7z_data/A_AA_comparision_data`；AIME 收包：`1_aime/1_7z_data/online_data`。点击来源「评测」后自动发现、清洗并持续评测全部有效未评数据。问财执行标准、归因、比较和改写并交付 MongoDB；AIME 每条回答归因通过后立即评分，不同回答共享并发，正式结果落盘供页面查看。
- 支持暂停收尾、立即停止、同 run 继续、失败重试与独立并发。关闭浏览器不影响运行，服务重启后等待手动继续。来源配置和阶段有效值可在工作台修改，统计日志上报默认关闭。专项、手动范围、聚类和问题库位于「更多」。操作见[工作台契约](docs/workbench.md)。

代码通过 Git 分发：本地提交并推送 `main`，`eval_agent_server` 从集群内的 `http://interactive-n01laf763gwn:8080/chenmingyang2/agent_eval_harness.git` 拉取。服务器使用独立的仓库只读凭据；不上传本地 checkout 或 Git bundle。

首次部署由本地一次性执行（SSH 目标为 `.servers.conf` 的 `eval_agent_server`）：

```bash
WORKBENCH_ADMIN_PASSWORD='<管理员密码>' npm run deploy:workbench
```

部署脚本从集群 Git 建立 checkout，安装仓库锁定的工具链，并在 checkout 外创建不覆盖已有文件的运行配置。日常更新先停止工作台，再在服务器执行：

```bash
ssh <eval_agent_server>
cd /mnt/aigc_team/user_workspace/chenmingyang/eval_harness/code
git pull --ff-only
bash workbench.sh start
```

`workbench.sh` 默认执行 `start`，前台运行；SSH 断开、Ctrl+C 或 SIGTERM 会停止整套服务并保存进度。需要断线后持续运行时，由操作者先进入 `tmux new -s workbench`，再执行启动命令。部署、更新、构建、查看状态和日志均不会启动服务；整套退出后必须手动再启，不注册开机自启。

服务器控制命令如下，可从任意目录执行脚本，并用 `--config FILE` 选择运行配置：

```bash
bash workbench.sh --help
bash workbench.sh check
bash workbench.sh status
bash workbench.sh logs --log runtime --lines 100 --follow
bash workbench.sh stop
```

`check` 只校验工具链、配置、依赖和端口，不安装依赖或启动子服务。`status` 和 `stop` 使用运行目录内仅服务器账号可访问的控制通道；`stop` 等待当前实例停止，不按端口或进程名杀进程。`npm run workbench -- <命令>` 使用同一个脚本入口。

启动不执行 `git pull`，首次缺少依赖或构建产物时执行 bootstrap/build，后续只构建过期产物。实例锁阻止重复启动。子服务异常在本次手动启动期间有限退避重启，`runtime/config/workbench.json` 的 `restart.limit` 可设为 `0` 关闭；配置错误、端口冲突或连续崩溃会停止整套服务。启动和子服务重启均不自动恢复评测来源，需手动点击「运行」。

工具链或依赖有变更时，在服务器运行 `npm run deploy:workbench -- --on-server` 准备工具链，随后 `npm run bootstrap && npm run build`。已有管理员配置时无需再提供密码。认证、代理与更新约束见[部署指南](docs/deployment.md)。

日常来源默认关闭统计日志生成与上报。显式启用统计交付的专项来源仍使用原 relay：

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
| 单回答评分、归因与AIME评测 | [独立回答评测](docs/answer-review.md) |
| AIME 新包清洗、增量评分与归因、启动和停止 | [AIME 增量归因](docs/aime-incremental.md) |
| 人工复核与评测实验 | [评测质量](docs/quality.md) |
| 提示词与工具描述 | [Prompts](packages/prompts/README.md) |
| 界面规则 | [PRODUCT.md](PRODUCT.md) |
| 同花顺数据服务 | [服务源码](server_dashboard_ths/README.md) |
| Eris 对话、数据与工具 | [Agent 说明](agent/README.md) |
| 离线汇报与历史快照 | [汇报模块](evaluation-report/README.md) |

Eris 只读分析助手部署在服务器，入口为 `http://117.50.195.94:3928`（内部 `5004`）。部署与账户管理见 [Eris](agent/README.md)；本机只进行开发与模拟验证。
