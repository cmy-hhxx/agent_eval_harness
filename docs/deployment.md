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

脚本读取 `.servers.conf` 的 `eval_agent_server`，只通过 SSH 下发部署命令；代码由服务器直接从 `http://interactive-n01laf763gwn:8080/chenmingyang2/agent_eval_harness.git` 克隆或快进到 `main`，不使用本地 origin，不传输 checkout 或 bundle。其他集群 Git 地址用 `--repository <URL>` 显式指定。脚本安装 `mise.toml` 锁定的 Node/npm/Python/uv，并执行 `scripts/workbench-init.mjs`。初始化不会覆盖已有的 `runtime/config` 或密钥，已有 `workbench.env` 时无需管理员密码。

服务器的 Git 认证必须提前配置：使用 `read:repository` 且仅授权本仓库的独立 token，凭据保存到 checkout 外的 `runtime/secrets/git-credentials`，权限 `600`；通过 Git credential helper 读取，禁止把 token 放进 origin、命令参数或 Git。服务器 checkout 的配置为：

```bash
git config credential.http://interactive-n01laf763gwn:8080.useHttpPath true
git config credential.http://interactive-n01laf763gwn:8080.helper \
  'store --file=/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime/secrets/git-credentials'
git config http.http://interactive-n01laf763gwn:8080/.proxy ''
```

本地 Git 网页入口为 `http://117.50.195.94:2167`，SSH origin 使用 `2177`；评测服务器使用集群地址的 `8080`。这与工作台网页映射是不同服务。集群 Git 不经过服务器 HTTP 代理；否则即使 DNS 和服务正常，也可能被代理返回 `403`。部署脚本为 Git 主机设置 `NO_PROXY/no_proxy`，并保存仓库 URL 范围的禁用代理配置，使后续普通 `git pull` 同样直连。无凭据返回 `401`，需要先配置 credential helper。

初始化后填写：

- `runtime/config/config.ini`：模型渠道地址、密钥与 `[environment]`。MongoDB 使用集群内原生连接串 `mongodb://interactive-q1qu5v9oqj3n:5000`；如认证或 TLS 由集群要求，在同一外部配置中补齐。
- `runtime/config/models.json`：实际网关模型 ID。
- `runtime/config/automations.json`：状态、输入快照、日志和 Mongo 交付目标。来源清单由 checkout 中的 `configs/automations.manifest.json` 控制。

`runtime/secrets/workbench.env` 由初始化生成，权限必须为 `600`。它只保存单管理员用户名、scrypt 密码哈希和 relay token，不保存明文密码，也不进入 JSON 状态。

## 启动

```bash
ssh <eval_agent_server>
cd /mnt/aigc_team/user_workspace/chenmingyang/eval_harness/code
tmux new -s workbench
bash workbench.sh
```

网关监听 `0.0.0.0:5001`，由已有 NAT 映射到外部 `3309`。数据服务只监听 `127.0.0.1:8081`，自动化看板只监听 `127.0.0.1:4174`，运行实例看板只监听 `127.0.0.1:4173`。不使用 systemd、Docker、Kubernetes 或自建 daemon；tmux 会话结束后进程停止。

浏览器入口：

- `http://117.50.195.94:3309/`

登录后在同一页通过一级导航切换模块；模块内定位与选择原位更新。`/runtime/api/` 和 `/data/<dataset>/` 下的数据接口只承载请求，不提供生产子页面。

登录用户由初始化时的 `--admin-user` 决定，默认 `cmy`。会话使用 HttpOnly、SameSite=Strict Cookie；重启工作台后需要重新登录。

## 更新代码

本地完成提交并推送 `main` 后，先在 tmux 中停止工作台和评测，再到服务器 checkout 执行：

```bash
git pull --ff-only
bash workbench.sh
```

只有依赖、vendor 或工具链发生变更时，启动前执行：

```bash
npm run deploy:workbench -- --on-server
npm run bootstrap
npm run build
```

`--on-server` 在当前服务器直接执行，不读取本地 `.servers.conf`，也不需要再次经过本机 SSH。部署只接受干净的代码目录和快进更新；服务器不修改业务源码，配置继续放在 `runtime/config/`。有未提交修改、分支分叉或 origin 不符时直接停止，不自动覆盖。代码更新不会自动启动评测来源。

## 启动与停止语义

- 实例锁阻止同一运行目录重复启动。
- 启动前校验固定工具链、配置、持久目录、密钥权限、运行账号权限和全部端口。
- 端口被其他进程占用时拒绝启动，不自动换端口。
- 数据服务、自动化看板服务和运行实例看板异常退出后按 `1s, 2s, 4s, 8s, 16s` 退避重启；同一服务在五分钟内超过五次重启、返回配置错误或端口冲突时停止整套服务。
- 启动与重启只恢复服务，不自动恢复来源流水线。评测页按来源点击「评测」后持续执行；暂停等待在途收尾，立即停止中断在途，之后手动继续。
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

- `0_wencai/1_7z_data/A_AA_comparision_data` 与 `0_wencai/2_daily_eval_input/<model>/<date>.jsonl`
- 后训练专项：`0_wencai/1_7z_data/post_train_model` 与 `0_wencai/5_multi_task_eval_input/post_train_model_eval/<model>/<date>.jsonl`；在[数据与任务](../server_dashboard_ths/README.md#任务压缩包批次与清洗)中点击清洗发布，不加入日常自动评测清单。
- `1_aime/1_7z_data/online_data` 与 `1_aime/2_daily_eval_input/<model>/<date>.jsonl`
- `2_ifind/1_7z_data` 与 `2_ifind/2_daily_eval_input/<model>/<date>.jsonl`

工作台发现登记目录中的包并保存持久批次；日常来源手动启动后自动清洗积压并持续接入新包，专项由页面选择批次并手动清洗。AIME 接管时核对已有规范输入与增量收据，分别补齐评分和归因覆盖。新任务创建独立收包与输出目录，目录和状态说明见[数据服务](../server_dashboard_ths/README.md)。外部状态位于 `runtime/state/data-service`，SQLite、ready、偏移索引、进度和临时解压目录均不在 checkout。

手动启动来源后，流水线从 `http://127.0.0.1:8081/data/wencai` 读取日常四路，并把进度直接上报同一数据服务。

## 日常检查

```bash
curl -fsS http://127.0.0.1:5001/health
curl -fsS http://127.0.0.1:8081/data/wencai/health
curl -fsS http://127.0.0.1:4174/api/health
curl -fsS http://127.0.0.1:4173/api/health
```

`/health` 未登录可见且只返回服务健康；其余页面与 API 需要管理员会话，relay API 只接受 Bearer token。

## 双日常来源配置

首次安装由 `workbench:init` 创建问财与 AIME 的独立配置。已有服务器更新后，先停止工作台与独立 AIME watch，确认进度已保存，再运行：

```bash
npm run workbench:configure-daily -- --runtime-root /mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime
bash workbench.sh
```

配置工具登记问财四路和 AIME 两阶段日常，保留 AIME 状态目录、现有模型覆盖和其他专项来源；问财切换为全量、Flash high、并发32，AIME总并发64。当前构建 Host 基底替换旧 checkout 配置引用，密钥继续读取既有网关配置。工具不启动来源，服务起来后由页面点击评测。

问财与 AIME 的运行/结果分别按自己的 workflow 读取，AIME 已接受归因保留，仅补缺少的评分。验收任务使用各来源 `eval_output/test_eval/`。
