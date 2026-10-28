# 服务器部署与运行

[返回首页](../README.md) · [使用指南](usage.md) · [Eris](../agent/README.md)

## 本地与服务器分工

本地只做代码开发、构建、模拟测试及 Git 提交推送。评测 Host、Worker、Eris 和真实模型验证均在服务器运行；服务器通过 Git 获取代码，数据、密钥、账号、聊天和正式结果保留在服务器，不随代码推送。

## 服务器数据目录

服务器数据根目录为 `/mnt/fin_bench/eval_data/`：

```text
/mnt/fin_bench/eval_data/
├── 0_wencai/
│   ├── 0_archive/
│   ├── 1_7z_data/
│   ├── 2_eval_input/
│   └── 3_eval_output/
├── 1_aime/
│   ├── 0_archive/
│   ├── 1_7z_data/
│   ├── 2_eval_input/
│   └── 3_eval_output/
├── 2_ifind/
│   ├── 0_archive/
│   ├── 1_7z_data/
│   ├── 2_eval_input/
│   └── 3_eval_output/
└── 4_user_kyc_data/
    ├── 0_wencai/
    ├── 1_aime/
    └── 2_ifind/
```

数据排查、分析和材料准备按下表选择范围，不默认扫描整个数据根目录：

| 目录 | 工作重点 |
|---|---|
| `{source}/2_eval_input/` | 评测输入，按任务选择文件读取 |
| `{source}/3_eval_output/` | 正式结果、报告、统计及恢复状态 |
| `4_user_kyc_data/{source}/` | 对应来源的用户 KYC 数据，按当前任务需要读取 |
| `{source}/0_archive/`、`{source}/1_7z_data/` | 默认不查看、不遍历；只有明确处理归档或压缩包的任务才进入 |

`4_user_kyc_data/` 属于重点数据范围，不代表 Eris 已自动接入该目录或存在 KYC 评测 Agent；具体能力以当前工具和 Agent 定义为准。

### 目录配置

以上目录是服务器工作约定，代码不内置数据根目录、来源名称或输出目录名。Host 的服务器覆盖配置显式填写 `inputs.versions[].sources[].path`、`output.path`、`output.testPath` 和 `problemLibrary.path`；相对路径按各自配置文件解析。`--test-eval`、`--pilot-cases`、归因试跑和稳定性实验只使用 `output.testPath`，请求的子目录必须位于该根目录内；未配置时明确报错。

Eris 的 `collectionsFile` 指向独立 JSON 清单，格式见[清单示例](../configs/collections.example.json)。每条记录用 `id` 表示稳定业务坐标，`path` 指向实际产物目录，`test:true` 标记仅在显式纳入测试时展示的目录；不标记时为正式目录。相对路径按清单文件位置解析。ID 与物理目录名独立，新增来源、改名或迁移目录只更新清单，不修改代码。ID 或路径重复、配置字段无效直接报错。

只登记要读取的评测产物目录；不把数据源根目录、输入、KYC、归档或压缩包目录放入 Eris 产物清单。KYC 与输入路径由实际使用它们的任务配置提供，不推导固定子目录，不复制真实数据或创建目录软链接来兼容另一种布局。

## 目录

| 内容 | 路径 |
|---|---|
| 代码部署根目录 | `/mnt/fin_bench/sync_datasets/code/1_eval_harnes/` |
| main checkout | `/mnt/fin_bench/sync_datasets/code/1_eval_harnes/main` |
| Eris checkout | `/mnt/fin_bench/sync_datasets/code/1_eval_harnes/eris-code` |
| 外部运行目录 | `/mnt/fin_bench/sync_datasets/code/1_eval_harnes/runtime` |
| 数据源 | `/mnt/fin_bench/eval_data` |
| 日常评测产物 | `/mnt/fin_bench/eval_data/{source}/3_eval_output/0_daily_eval/` |
| 专项评测产物 | `/mnt/fin_bench/eval_data/{source}/3_eval_output/1_task_eval/<任务>/` |
| 测试评测产物 | `/mnt/fin_bench/eval_data/{source}/3_eval_output/test_eval/` |
| 配置与密钥 | `runtime/config/`、`runtime/secrets/` |
| 状态与锁 | `runtime/state/` |
| 日志 | `runtime/log/runtime.log`、`runtime/log/evaluation.log` |

`source` 使用实际来源目录，例如 `0_wencai`、`1_aime`、`2_ifind`。配置、输入、账号和结果独立于 checkout。正式结果与恢复状态随 run 存在对应输出目录，不另存到 checkout 或 `runtime/data/runs`。

所有分支、提交或专项用途的代码均部署在上述代码根目录的独立子目录，目录名由操作者按用途指定；`runtime/` 专用于持久配置、密钥、账号、聊天、状态和日志，不存放 checkout。停止使用 `user_workspace` 下的代码和运行目录，不保留指向旧位置的软链接。不同 checkout 共用外部配置时仍须遵守实例锁，更新代码不会自动启动评测或调度任务。

废弃的进程、checkout、一次性脚本、实验配置与状态、历史输入副本、旧运行日志及迁移备份直接清理，不留档。保留当前服务配置、密钥、账号与聊天、跨 run 问题库及统计记录；数据源的原始输入和正式评测结果不属于部署清理范围。

## 评测 Host

在服务器配置锁定工具链、渠道密钥与显式输入，按 [README](../README.md#本地开发) 安装构建。使用外部配置启动：

```bash
EVAL_CONFIG_FILE=/absolute/path/config.ini npm run eval -- preflight \
  --config configs/host.json --config /absolute/path/models-and-inputs.json
EVAL_CONFIG_FILE=/absolute/path/config.ini npm run eval -- run --run-id comparison-001 \
  --config configs/host.json --config /absolute/path/models-and-inputs.json \
  --output /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval
```

命令前台执行，需要断线后继续时由操作者在 tmux 中启动。中断后使用相同 run ID 与配置续跑；已接受结果保留。运行、并发和恢复命令见[使用指南](usage.md#运行与恢复)。

Host 热状态默认写入 `~/.cache/eval-agent-harness/hot`，可通过 `EVAL_HOT_STATE_ROOT` 指定服务器本机 SSD。正式 JSONL、`progress.jsonl`、报告和 `state.json` 仍写评测产物目录。

Worker 启动期限保持 60 秒。启动超时与短暂连接故障使用任务持久化的 `transportFailures` 和 `execution.retries` 有界重试，每次重建 Worker；启动失败不消耗模型尝试。耗尽后只将受影响任务标记失败，保存计数、原因并记录 `worker_startup_retries_exhausted`，其余任务继续；同 run 恢复不清零累计预算。

## 更新代码

先停止对应 Host 或 Eris 进程并等待保存完成，再在服务器对应 checkout（主线为 `/mnt/fin_bench/sync_datasets/code/1_eval_harnes/main`）执行 `git pull --ff-only`。依赖、vendor 或工具链有变化时重新执行 `npm run bootstrap`，随后 `npm run build`、`npm run doctor`。更新完成后手动启动所需入口。

代码由服务器通过 Git 获取，凭据保存在 checkout 外，权限 `600`；密钥不进入 origin、命令参数或 Git。服务器配置继续保存在外部运行目录。

手动更新主线时，从 `main/` checkout 显式使用外置凭据文件：

```bash
git -c credential.helper='store --file=/mnt/fin_bench/sync_datasets/code/1_eval_harnes/runtime/secrets/git-credentials' \
  -c http.proxy= pull --ff-only origin main
```

## Eris 只读分析助手

Eris 使用独立代码目录 `/mnt/fin_bench/sync_datasets/code/1_eval_harnes/eris-code`，持久目录为同一部署根目录下的 `runtime/`；评测与分析使用各自的启动入口。

使用[服务配置示例](../configs/eris.example.json)准备服务器外置配置和产物清单。部署脚本默认使用上述 Eris checkout 与运行目录，必须显式提供渠道配置和产物清单路径：

```bash
read -rs ERIS_ADMIN_PASSWORD
export ERIS_ADMIN_PASSWORD
npm run deploy:eris -- --config <连接配置.servers.conf> --branch main \
  --source-ini /mnt/fin_bench/sync_datasets/code/1_eval_harnes/runtime/config/config.ini \
  --collections-file /mnt/fin_bench/sync_datasets/code/1_eval_harnes/runtime/config/collections.json --start
unset ERIS_ADMIN_PASSWORD
```

密码应通过私密环境输入提供，不写入命令历史。部署脚本通过 SSH stdin 传递初始化密码，代码由服务器从集群 Git 读取；复用既有只读 Git 凭据，不传输本机输入、结果、聊天或 checkout。

需要部署其他分支时显式传入 `--branch` 和 `--code-path /mnt/fin_bench/sync_datasets/code/1_eval_harnes/<用途>`。脚本拒绝根目录之外、`runtime/` 内或经软链接跳转的代码路径；`--runtime-root` 只接受固定的外部运行目录。

部署优先使用 mise；服务器已通过系统路径安装同一组锁定版本时直接复用，启动和部署均校验 Node/npm/Python/uv 的精确版本，不允许版本降级。

初始化只在缺失时创建 `runtime/config/eris.ini`、`runtime/config/eris.json` 和 `runtime/secrets/eris/accounts.json`。渠道取显式指定的服务器 INI，产物目录取 `--collections-file`；独立绑定实际模型 `deepseek-v4.1-flash`，推理默认 `high`、支持 `low / high / xhigh / max`。已有文件须符合当前配置 Schema，不自动覆盖或转换；已有账号不重置密码，后续更新可不传初始化密码。

`eris` tmux 会话内前台运行 `bash agent/run.sh --config <runtime/config/eris.json>`；内部 `0.0.0.0:5004`，外部既有映射为 `http://117.50.195.94:3928`。启动使用实例锁，端口冲突直接报错。部署不自动关闭旧 `eris` 会话，更新前应只停止该会话中的 Eris。

Comparison 的预计算统计由评测写入端保存到 `overview.json`。评测 Host 也需使用包含该写入逻辑的代码；仅更新 `eris-code` 不会改变评测产物。既有当前契约运行停止后，可用 `node scripts/rebuild-run-overviews.mjs <运行根目录>` 重建索引。归档报告与独立问题树通过公开资产工具直接读取，不转换归档状态。

验证 `/health`、未登录拒绝、管理员登录、账户停用/重置、流式回复与重连，并读取 Wencai Comparison 的运行统计及 AIME Attribution 的公开结果资产。没有 `overview.json` 的独立 Attribution 结果使用资产工具读取，不按 Comparison 重建统计索引。真实模型验证仅在服务器执行。回退只切换 Eris checkout 并重启该服务，保留账号、聊天和所有评测数据。

账号管理、只读能力和恢复见 [Eris](../agent/README.md)。当前 HTTP 入口不提供传输加密。
