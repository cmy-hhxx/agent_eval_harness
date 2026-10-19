# 同花顺远程输入数据看板

本目录维护远程输入数据服务、日期看板、样本浏览页和本地评测进度上报工具。服务运行在项目根目录 `.servers.conf` 的 **`eval_input_data_server`** 服务器上；连接配置与密钥保留在本机，`.servers.conf` 不入库。

| 项目 | 当前配置 |
|---|---|
| 看板 | <http://117.50.195.94:2256/> |
| 浏览器文档 | <http://117.50.195.94:2256/docs> |
| 远端程序目录 | `/mnt/fin_bench/A_AA_comparision_data/0_process_code` |
| 原始输入 | `/mnt/fin_bench/A_AA_comparision_data/*.7z` |
| 分日输出 | `/mnt/fin_bench/A_AA_comparision_data/2_eval_data_input/<model>/<date>.jsonl` |
| 监听端口 | 服务内 `8081`，公网映射 `2256`，对应配置项 `data_port` |

这是独立的 Python 数据服务；不启动评测 Worker，也不改写评测判词。四个内部模型 ID 为 `a_fast`、`b_fast`、`a_expert`、`b_expert`，输入中的 `AA` 映射到 B组。采集格式、去重、日期归属、进度口径和 HTTP 接口以 [服务文档](docs/handoff.md) 为准。

## 文件与依赖

- `app.py`：监听根目录归档，生成分日 JSONL、记录索引并提供 HTTP 接口。
- `dashboard.*`、`records.*`、`docs.html`：日期表、样本浏览页和文档页。
- `progress_bridge.py`：在本地读取 Host 的 `state.json`，按日期和 Fast/Expert 对战组上报进度；服务端不运行此工具。
- `deploy.py`：从 `.servers.conf` 的 `eval_input_data_server` 读取 SSH 连接参数，同步程序和重启远端服务。
- `test_*.py`、`dashboard.test.mjs`：归档、格式适配、接口、部署命令和页面回归测试。

运行需要 Python 3.10+ 和 `requirements.txt` 中的 `py7zr`；远端当前使用 Python 3.10.12。页面测试使用仓库根目录已安装的 Node.js / `jsdom`。

本地使用仓库根目录的 `.venv`（尚未创建时先运行 `uv venv .venv --python 3.12`），安装服务依赖：

```bash
uv pip install --python .venv/bin/python -r server_dashboard_ths/requirements.txt
```

本地启动时为数据指定独立目录，运行状态和记录索引写在程序旁的 `state/`：

```bash
DATA_ROOT=/tmp/ths-dashboard-data PORT=8081 .venv/bin/python server_dashboard_ths/app.py
```

测试与类型检查：

```bash
.venv/bin/python -m unittest discover -s server_dashboard_ths -p 'test_*.py'
node --test server_dashboard_ths/dashboard.test.mjs
pyright --pythonpath .venv/bin/python server_dashboard_ths/app.py server_dashboard_ths/progress_bridge.py server_dashboard_ths/deploy.py
```

## 部署与运行

在项目根目录 `.servers.conf` 中配置 `[eval_input_data_server]` 的 `host`、`user`、`port`、`auth = key` 和 `key`。需要本机安装 SSH、rsync，并已信任目标主机。远端首次安装依赖时，在程序目录执行：

```bash
python3 -m pip install --target .packages -r requirements.txt
```

后续从仓库根目录部署：

```bash
python3 server_dashboard_ths/deploy.py
```

部署只同步明确列出的程序、静态资源、依赖清单与文档，检查远端依赖后重启 `app.py`，再验证 `/health`。不删除远端文件，不上传原始数据，也不重新登记历史导入。需要使用其他本机连接文件时可传 `--config /path/to/.servers.conf`，服务器节名仍为 `eval_input_data_server`。

远端服务通过 `nohup` 等价的独立进程常驻，PID 在 `service.pid`，输出在 `service.log`。归档监听随服务启动；每 5 秒检查一次，输入稳定 30 秒后按既有规则重建，期间继续提供上一份完整快照。部署后可检查 `/dashboard-data`、`state/root-archives.json` 和 `service.log`。服务器重启后手动在远端程序目录运行 `nohup python3 app.py >> service.log 2>&1 </dev/null &`，并将新 PID 写入 `service.pid`。

手动登记已经上传的本地权威数据时，在远端使用 `python3 app.py --register-local-import YYYY-MM-DD`；它会验证并索引该日期的四个模型文件。日常部署不执行此命令。

本地进度上报示例：

```bash
python3 server_dashboard_ths/progress_bridge.py data/runs/comparison/<run-id>/state.json --once
```

`state/`、`.packages/`、虚拟环境、日志、PID、压缩包和真实输入均不属于仓库源码。看板与完整 JSONL 接口当前公开可访问，服务无鉴权。
