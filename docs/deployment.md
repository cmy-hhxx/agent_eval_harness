# 远程工作台部署与运行

[返回首页](../README.md) · [自动化](automations.md) · [数据服务](../server_dashboard_ths/README.md)

## 目录

| 内容 | 路径 |
|---|---|
| Git checkout | `/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/code` |
| 外部运行目录 | `/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime` |
| 数据源 | `/mnt/fin_bench/eval_data` |
| 日常评测产物 | `/mnt/fin_bench/eval_data/{source}/eval_output/0_daily_eval/` |
| 专项评测产物 | `/mnt/fin_bench/eval_data/{source}/eval_output/1_task_eval/<任务>/` |
| 所有测试评测产物 | `/mnt/fin_bench/eval_data/{source}/eval_output/test_eval/` |
| 配置 | `runtime/config/` |
| 密钥 | `runtime/secrets/workbench.env` |
| 状态与锁 | `runtime/state/` |
| 日志 | `runtime/log/runtime.log`、`runtime/log/evaluation.log`、`runtime/log/comparison-statistics-log.jsonl` |

checkout 可以替换或重新克隆，运行目录不放入 Git。工作台只从 checkout 读取代码与来源清单，不把 `.servers.conf`、SSH 私钥或本机路径带入服务器运行。

`source` 使用实际来源目录：`0_wencai`、`1_aime`、`2_ifind`。初始化为每个来源建立上述三个输出目录。正式结果、run 恢复状态、报告及显式 debug 材料都随 run 存在对应输出目录，禁止另存到 checkout 或 `runtime/data/runs`，也不建立指向旧目录的软链接。看板与自动化的 Host 配置必须指向相同的当前来源和任务目录；验证任务使用 `--test-eval` 或独立测试覆盖配置。

## 首次部署

本地先提交并推送要部署的 Git 分支，然后设置管理员密码环境变量并执行：

```bash
WORKBENCH_ADMIN_PASSWORD='<管理员密码>' npm run deploy:workbench
```

脚本读取 `.servers.conf` 的 `eval_data_server`，通过 Git origin 建立或快进服务器 checkout，安装 `mise.toml` 锁定的 Node/npm/Python/uv，并执行 `scripts/workbench-init.mjs`。初始化不会覆盖已有的 `runtime/config` 或密钥。

初始化后填写：

- `runtime/config/config.ini`：模型渠道地址、密钥与 `[environment]`。MongoDB 使用集群内原生连接串 `mongodb://interactive-q1qu5v9oqj3n:5000`；如认证或 TLS 由集群要求，在同一外部配置中补齐。
- `runtime/config/models.json`：实际网关模型 ID。
- `runtime/config/automations.json`：状态、输入快照、日志和 Mongo 交付目标。来源清单由 checkout 中的 `configs/automations.manifest.json` 控制。

`runtime/secrets/workbench.env` 由初始化生成，权限必须为 `600`。它只保存单管理员用户名、scrypt 密码哈希和 relay token，不保存明文密码，也不进入 JSON 状态。

## 启动

```bash
ssh <eval_data_server>
cd /mnt/aigc_team/user_workspace/chenmingyang/eval_harness/code
tmux new -s workbench
bash workbench.sh
```

网关监听 `0.0.0.0:5001`，由已有 NAT 映射到外部 `3309`。数据服务只监听 `127.0.0.1:8081`，自动化看板只监听 `127.0.0.1:4174`，运行实例看板只监听 `127.0.0.1:4173`。不使用 systemd、Docker、Kubernetes 或自建 daemon；tmux 会话结束后进程停止。

浏览器入口：

- `http://117.50.195.94:3309/`

登录后在同一页通过一级导航切换模块；模块内定位与选择原位更新。`/runtime/api/` 和 `/data/<dataset>/` 下的数据接口只承载请求，不提供生产子页面。

登录用户由初始化时的 `--admin-user` 决定，默认 `cmy`。会话使用 HttpOnly、SameSite=Strict Cookie；重启工作台后需要重新登录。

## 启动与停止语义

- 实例锁阻止同一运行目录重复启动。
- 启动前校验固定工具链、配置、持久目录、密钥权限、运行账号权限和全部端口。
- 端口被其他进程占用时拒绝启动，不自动换端口。
- 数据服务、自动化进程和运行实例看板异常退出后按 `1s, 2s, 4s, 8s, 16s` 退避重启；同一服务在五分钟内超过五次重启、返回配置错误或端口冲突时停止整套服务。
- Ctrl+C 或 SIGTERM 先停止公网接入，再依次停止自动化、运行实例看板和数据服务；自动化进程完成 Host 进度保存后退出。
- supervisor 输出留在 tmux；应用日志只写现有 `runtime.log`、`evaluation.log` 和统计 JSONL，不创建轮转或私有日志。

## 统计 relay

服务器每四小时生成并校验冻结 Schema 后的累计快照，追加到 `runtime/log/comparison-statistics-log.jsonl`，然后进入 `pending`。服务器不直接 POST 外部报表地址。

本地只需运行：

```bash
export WORKBENCH_SERVER_URL=http://117.50.195.94:3309
export WORKBENCH_RELAY_TOKEN='<runtime/secrets/workbench.env 中的 WORKBENCH_RELAY_TOKEN>'
export WORKBENCH_RELAY_STATE="$HOME/.agent-eval-workbench/report-relay.json"
npm run report:relay -- --once
```

relay 只读取待上传统计记录，使用记录自带的 `logUrl`、冻结记录正文和回执状态，不下载输入或评测正文。可以按需周期调度，默认不常驻。明确的请求拒绝保持 `pending`；网络中断、超时、5xx、重定向或无法解析的成功回执标记 `uncertain`，不会自动重发。人工核对后使用：

```bash
npm run report:relay -- --resolve <traceId> --outcome written --request-id <requestId>
npm run report:relay -- --resolve <traceId> --outcome retry
```

只有确认外部系统未写入时才选择 `retry`。

## 数据服务

`/mnt/fin_bench/eval_data` 当前按来源组织：

- `0_wencai/1_7z_data` 与 `0_wencai/2_daily_eval_input/<model>/<date>.jsonl`
- 后训练专项：`0_wencai/1_7z_data/post_train_model` 与 `0_wencai/5_multi_task_eval_input/post_train_model_eval/<model>/<date>.jsonl`；在[数据与任务](../server_dashboard_ths/README.md#任务压缩包批次与清洗)中点击清洗发布，不加入日常自动评测清单。
- `1_aime/1_7z_data` 与 `1_aime/2_daily_eval_input/<model>/<date>.jsonl`
- `2_ifind/1_7z_data` 与 `2_ifind/2_daily_eval_input/<model>/<date>.jsonl`

工作台发现登记目录中的包并保存持久批次；日常自动清洗，专项由页面操作。已有正式输入文件保留但不自动回填 ready。新任务创建独立收包与输出目录，目录和状态说明见[数据服务](../server_dashboard_ths/README.md)。外部状态位于 `runtime/state/data-service`，SQLite、ready、偏移索引、进度和临时解压目录均不在 checkout。

自动化从 `http://127.0.0.1:8081/data/wencai` 读取日常四路，并把进度直接上报同一数据服务。

## 日常检查

```bash
curl -fsS http://127.0.0.1:5001/health
curl -fsS http://127.0.0.1:8081/data/wencai/health
curl -fsS http://127.0.0.1:4174/api/health
curl -fsS http://127.0.0.1:4173/api/health
```

`/health` 未登录可见且只返回服务健康；其余页面与 API 需要管理员会话，relay API 只接受 Bearer token。
