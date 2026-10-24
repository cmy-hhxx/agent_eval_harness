# 同花顺远程数据服务

[返回首页](../README.md) · [工作台部署](../docs/deployment.md) · [接口](../docs/handoff.md) · [服务文档](docs/handoff.md)

本目录维护工作台内只监听回环地址的 Python 数据服务，负责监听新包、稳定性检查、增量发布 JSONL、ready 状态、样本浏览和进度展示。它不启动评测模型，不改写判词。

## 当前布局

| 内容 | 路径 |
|---|---|
| 数据根 | `/mnt/fin_bench/eval_data` |
| 外部状态根 | `runtime/state/data-service` |
| wencai 日常包 | `0_wencai/1_7z_data/A_AA_comparision_data/*.7z` |
| wencai 输出 | `0_wencai/2_daily_eval_input/<model>/<date>.jsonl` |
| 问财后训练专项包 | `0_wencai/1_7z_data/post_train_model/*.7z` |
| 问财后训练专项输出 | `0_wencai/5_multi_task_eval_input/post_train_model_eval/<model>/<date>.jsonl` |
| aime 日常包与输出 | `1_aime/1_7z_data/online_data/*.7z`、`1_aime/2_daily_eval_input/<model>/<date>.jsonl` |
| ifind 包与输出 | `2_ifind/1_7z_data/*.7z`、`2_ifind/2_daily_eval_input/<model>/<date>.jsonl` |

服务进程只由 `workbench.sh` 启动，监听 `127.0.0.1:8081`。对外页面和 API 通过工作台网关提供：

- `/data/wencai/`
- `/data/post_training_model/`
- `/data/aime/`
- `/data/ifind/`

生产默认进入工作台 `/` 的数据与任务区；清洗、报告和样本均在当前页面操作。来源与日常/专项类型独立，新建任务的输入模型组由来源决定；wencai 可选四模型或后训练双模型。

## 任务、压缩包批次与清洗

1. 新建任务，选择来源、类型与输入模型组。任务使用持久化 UUID，页面返回 `<来源>/1_7z_data/<任务 UUID>/` 收包目录。
2. 上传包，或选已有未清洗批次归入任务。每个包独立稳定 30 秒后可清洗；上传过程中的增长不创建重复批次，已稳定包被替换时创建关联原批次的新批次，等待人工归属。
3. 目录扫描只登记包，不触发清洗。手动清洗仍可选择批次；日常来源在明确运行后，由 Host 请求任务级清洗。每次冻结当前稳定、尚未清洗或被中断的批次，异步处理完即退出；后续新包等待下一轮请求。失败包通过明确重试处理，不在扫描中无限重放。已清洗批次不能改归属。
4. 查看清洗报告：读入记录、纳入回答、排除记录、问题及本批次有效模型对分别计数。排除、纳入和标签与效率异常分别分页，可按原包/成员文件/行号定位，纳入回答可按需读取样本。

5. 勾选同一任务的已清洗批次，点击「评测所选批次」，到运行区预检并启动；范围与恢复操作见[工作台契约](../docs/workbench.md#当前批次运行操作)。

首次登记现有四个来源目录时，问财四模型和 AIME 绑定日常任务，后训练、ifind 绑定专项任务。这些是目录默认归属，不限制新建任务的类型。日常来源沿用已有任务 UUID 和规范输入目录。新任务目录绑定其自身任务；新建任务不会自动清洗或隐式启动评测，评测来源仍见[自动化配置](../docs/automations.md#来源清单)。AIME 专用增量执行器是该来源的唯一自动清洗者；目录扫描从相同发布库读取已提交收据及报告，更新批次状态，不再次解包。

新建任务规范输入写入 `<来源>/2_daily_eval_input/<任务 UUID>/<模型>/<日期>.jsonl` 或 `<来源>/5_multi_task_eval_input/<任务 UUID>/<模型>/<日期>.jsonl`，默认任务沿用上表既有输出目录。`/data/task-<任务 UUID>/` 提供同一套日期、ready、下载与样本接口。

任务、目录归属、包批次和清洗摘要存于外部状态根的 `workbench.sqlite`；任务专用处理状态在 `tasks/<任务 UUID>/`。逐条清洗报告存于对应数据集的 `archive-records.sqlite`，与输入发布计划在同一个事务中保存；重启后先恢复发布，再读取原报告，不重新提取成功输入。工作台索引只保存关联和摘要，不复制报告正文、输入或正式评测结果。

### 工作台接口

接口通过已登录的工作台网关访问，数据服务仅监听回环地址。创建、归属和清洗只接受 JSON。

| 接口 | 行为 |
|---|---|
| `GET /data/workbench/catalog` | 仅读已提交的任务与分页批次索引；支持 source/category/task/status/unassigned/page/page_size。page_size 为 1–100，默认 50；目录发现由后台轮询和显式清洗负责 |
| `POST /data/workbench/tasks` | 创建任务：name、source、category、profile |
| `POST /data/workbench/assign` | 批量归属：batch_ids、task_id；整组验证后提交 |
| `POST /data/workbench/evaluation-scope` | Host 内部读取同任务已清洗批次的固定记录坐标、模型组和来源输出路径；不接收浏览器传入路径 |
| `POST /data/workbench/clean` | 批量异步清洗：batch_ids，返回 202；未稳定、未归属和并发请求明确拒绝 |
| `GET /data/workbench/tasks/<UUID>/clean` | 当前任务清洗状态：task_id、status、batch_ids、current_batch_id、completed、remaining |
| `POST /data/workbench/tasks/<UUID>/clean` | 空对象；冻结当前 ready/interrupted 范围并异步排空，返回 202；重复请求活动任务返回同一状态，其他清洗占用时返回 409 |
| `POST /data/workbench/tasks/<UUID>/clean/stop` | 空对象；停止派发后续包，当前包完成后退出，未开始包恢复 ready |
| `POST /data/workbench/tasks/<UUID>/clean/cancel` | 空对象；同时取消当前包，事务提交前回滚暂存并保留 interrupted 待继续；已提交发布须完成恢复 |
| `GET /data/workbench/batches/<UUID>/report` | section 为 exclusions、records 或 metadata_issues；page、page_size 按原报告顺序分页，page_size 为 1–100，默认 50 |
| `GET /data/workbench/batches/<UUID>/sample` | 按纳入报告的零基 index 读取一个样本；输入改变或缺失明确报错 |

同任务不接受来自不同目录的同名包，避免底层包收据混淆；可建立独立任务区分。任务名称不参与文件路径，输入的业务 `batch_id`、`case_id` 保留原义。

清洗状态为 idle、queued、running、stopping、stopped、cancelling、cancelled、finished。任务级清洗和手动清洗共享现有单实例锁，来源关闭时不得继续请求新清洗。取消在解包返回、逐条处理、暂存和事务提交前检查；第三方解包调用返回前不会发布输入。已经提交的发布事务继续完成，不把半套文件暴露给评测器。进程重启后只恢复已提交发布，待处理包保持 interrupted，等待再次明确运行。

开发时也可对一个登记来源显式导入，不启动 HTTP 或模型：

AIME 的“扫描→清洗→增量归因”入口见[AIME 增量归因](../docs/aime-incremental.md)。它调用本模块已有规范化、锁和事务发布机制；默认单次运行，加 `--watch` 后由评测脚本持续扫描，不启动本服务的监听循环。

```bash
DATA_ROOT=/mnt/fin_bench/eval_data \
STATE_ROOT=/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime/state/data-service \
PYTHONPATH=/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime/python-packages \
python3 server_dashboard_ths/app.py --process-archives post_training_model
```

只扫描各已登记收包目录的顶层 `.7z`，不递归读临时目录。后训练日期优先取 `meta.testset_name` 中唯一有效日期，否则取请求的北京时间日期，原 `request_time` 保留。

## 文件

- `app.py`：统一 HTTP 服务、规范化、增量发布、SQLite 恢复、ready、日期、样本和进度接口。
- `workbench_catalog.py`：任务与包批次索引、独立目录、稳定检查、清洗执行和报告关联。
- `cleaning_report.py`：排除原因、原始坐标和清洗计数。
- `metadata.py`：RUED 难度计算、业务标签补齐和效率指标规整。
- `multi_agent_inputs.py`：aime/ifind 会话适配，复用同一处理引擎；完整保留 trace、轮次、meta 和原顺序。
- `dashboard.*`、`records.*`、`docs.html`：日期、样本和文档页面。
- `records-markdown.js`：样本回答的安全 Markdown/GFM 渲染。
- `build.mjs`：把样本页打包为不提交的 `records.bundle.js`。
- `requirements.txt`：Python 数据处理依赖；工作台首次启动安装到外部 `runtime/python-packages`。

状态、SQLite、记录偏移、ready、处理进度、归档维护和临时解压目录全部位于配置的外部状态根，不写入 checkout。

## 处理语义

- 每 5 秒发现新包，各包独立稳定 30 秒；日常与专项均等待手动清洗。失败不会无限自动重试，可显式再次清洗。
- 已成功发布的数据不回撤、不重放；同业务身份内容一致则排除为重复，不一致则记录冲突并保留已发布内容。补传仅追加新的有效记录。
- 输出日期取请求时间的北京时间日期；过滤无日期、无身份、无问题、空回答或采集失败记录。
- 只写受影响模型和日期，原包保留原处。坏记录自动排除，坏文件或包不阻断其他独立数据；答案保持原文，标签和效率指标按[清洗口径](docs/metadata.md)规整。历史归档目录的显式整理命令仍可使用，不自动移动新包。
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
