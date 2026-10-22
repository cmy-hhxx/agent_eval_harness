# 同花顺远程数据服务

[返回首页](../README.md) · [工作台部署](../docs/deployment.md) · [接口](../docs/handoff.md) · [服务文档](docs/handoff.md)

本目录维护工作台内只监听回环地址的 Python 数据服务，负责监听新包、稳定性检查、增量发布 JSONL、ready 状态、样本浏览和进度展示。它不启动评测模型，不改写判词。

## 当前布局

| 内容 | 路径 |
|---|---|
| 数据根 | `/mnt/fin_bench/eval_data` |
| 外部状态根 | `runtime/state/data-service` |
| wencai 包 | `0_wencai/1_7z_adta/*.7z` |
| wencai 输出 | `0_wencai/2_daily_eval_input/<model>/<date>.jsonl` |
| aime 包与输出 | `1_aime/1_7z_data/*.7z`、`1_aime/2_daily_eval_input/<model>/<date>.jsonl` |
| ifind 包与输出 | `2_ifind/1_7z_data/*.7z`、`2_ifind/2_daily_eval_input/<model>/<date>.jsonl` |

服务进程只由 `workbench.sh` 启动，监听 `127.0.0.1:8081`。对外页面和 API 通过工作台网关提供：

- `/data/wencai/`
- `/data/aime/`
- `/data/ifind/`

`/data/` 是数据区域首页。服务不提供 `/wencai`、`/aime`、`/ifind` 等平行入口。

## 文件

- `app.py`：统一 HTTP 服务、包扫描、稳定检查、增量去重、SQLite 发布恢复、ready、日期目录、样本和进度接口。
- `multi_agent_inputs.py`：aime/ifind 会话适配，复用同一处理引擎；完整保留 trace、轮次、meta 和原顺序。
- `dashboard.*`、`records.*`、`docs.html`：日期、样本和文档页面。
- `records-markdown.js`：样本回答的安全 Markdown/GFM 渲染。
- `build.mjs`：把样本页打包为不提交的 `records.bundle.js`。
- `requirements.txt`：Python 数据处理依赖；工作台首次启动安装到外部 `runtime/python-packages`。

状态、SQLite、记录偏移、ready、处理进度、归档维护和临时解压目录全部位于配置的外部状态根，不写入 checkout。

## 处理语义

- 每 5 秒检查新包；每个新增或变化包独立稳定 30 秒后处理，坏包未变化时不反复重试。
- 已成功发布的数据不回撤、不重放；同名补传和增量包按业务身份合并。
- 输出日期取请求时间的北京时间日期；过滤无日期、无身份、无问题、空回答或采集失败记录。
- 只写受影响模型和日期；成功原包移动到来源自己的 `0_archive` 或 `3_processed_archives` 分卷目录。
- 正式 JSONL、归档原包和现有输入不删除。部署后的新服务从空状态开始；历史正式文件保留，但不自动回填 ready。
- aime/ifind 会话一行保存完整 session，不拆分、不裁剪、不重排 trace 与消息。

## 本地验证

```bash
node server_dashboard_ths/build.mjs
python3 -m unittest discover -s server_dashboard_ths -p 'test_*.py'
node --test server_dashboard_ths/dashboard.test.mjs
```

本地直接启动时也必须提供外部数据与状态目录：

```bash
DATA_ROOT=/tmp/eval_data STATE_ROOT=/tmp/eval-state \
  PORT=8081 HOST=127.0.0.1 python3 server_dashboard_ths/app.py
```
