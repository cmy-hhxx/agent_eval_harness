# 同花顺远程输入数据看板

本目录维护远程输入数据服务、日期看板、样本浏览页和本地评测进度上报工具。服务运行在项目根目录 `.servers.conf` 的 **`eval_input_data_server`** 服务器上；连接配置与密钥保留在本机，`.servers.conf` 不入库。

| 项目 | 当前配置 |
|---|---|
| 看板 | <http://117.50.195.94:2256/> |
| 浏览器文档 | <http://117.50.195.94:2256/docs> |
| 远端程序目录 | `/mnt/fin_bench/A_AA_comparision_data/0_process_code` |
| 原始输入 | `/mnt/fin_bench/A_AA_comparision_data/*.7z` |
| 已处理原包 | `/mnt/fin_bench/A_AA_comparision_data/3_processed_archives/<包日期>/part-NNNN/` |
| 分日输出 | `/mnt/fin_bench/A_AA_comparision_data/2_eval_data_input/<model>/<date>.jsonl` |
| GPT 六路看板 | <http://117.50.195.94:2256/gpt/> |
| GPT 原始输入 | `/mnt/fin_bench/A_AA_comparision_data/gpt/*.7z` |
| GPT 分日输出 | `/mnt/fin_bench/A_AA_comparision_data/gpt/2_eval_data_input/<model>/<date>.jsonl` |
| GPT 已处理原包 | `/mnt/fin_bench/A_AA_comparision_data/gpt/3_processed_archives/<包日期>/part-NNNN/` |
| 监听端口 | 服务内 `8081`，公网映射 `2256`，对应配置项 `data_port` |

这是独立的 Python 数据服务；不启动评测 Worker，也不改写评测判词。原四路保留 `a_fast`、`b_fast`、`a_expert`、`b_expert`；GPT 使用独立六路数据集。输入中的 `AA` 映射到 B组。采集格式、去重、日期归属、进度口径和 HTTP 接口以 [服务文档](docs/handoff.md) 为准。

## 文件与依赖

- `app.py`：同一进程监听原四路、GPT、aime、ifind，隔离各自的增量状态与输出，通过同一 HTTP 端口提供看板与取数接口。
- `dashboard.*`、`records.*`、`docs.html`：日期表、样本浏览页和文档页。`records-markdown.js` 通过仓库已有的 Markdown/GFM 解析器生成 DOM，`build.mjs` 将页面源码打包为忽略入库的 `records.bundle.js`。
- `progress_bridge.py`：在本地读取 Host 的 `state.json`，按日期和实际模型对上报进度；服务端不运行此工具。
- `deploy.py`：从 `.servers.conf` 的 `eval_input_data_server` 读取 SSH 连接参数，同步程序和重启远端服务。
- `multi_agent_inputs.py`：aime/ifind 数据源适配，复用 `app.py` 的增量处理引擎；随统一看板部署，没有独立服务。
- `test_*.py`、`dashboard.test.mjs`：归档、格式适配、接口、部署命令和页面回归测试。

运行需要 Python 3.10+ 和 `requirements.txt` 中的 `py7zr`；远端当前使用 Python 3.10.12。页面构建和测试使用仓库根目录已安装的 Node.js、esbuild、Markdown/GFM 依赖和 `jsdom`；远端不需要 Node.js，也不依赖外部 CDN。

本地使用仓库根目录的 `.venv`（尚未创建时先运行 `uv venv .venv --python 3.12`），安装服务依赖：

```bash
uv pip install --python .venv/bin/python -r server_dashboard_ths/requirements.txt
```

本地启动时用 `DATA_ROOT` 指定独立数据目录。原四路与 GPT 的运行状态和记录索引写在程序旁的 `state/`；aime/ifind 的输入、产物和状态默认放在 `DATA_ROOT/multi_agent_eval/`，可用 `MULTI_AGENT_ROOT` 单独指定。未设置 `DATA_ROOT` 时沿用服务器的 `/mnt/fin_bench/multi_agent_eval/`：

```bash
node server_dashboard_ths/build.mjs
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

部署先在本机打包样本页，再同步明确列出的程序、静态资源、依赖清单与文档，检查远端依赖后重启 `app.py`，再验证原四路、GPT、aime、ifind 的 `/health`。不删除远端文件，不上传原始数据，也不重新登记历史导入。需要使用其他本机连接文件时可传 `--config /path/to/.servers.conf`，服务器节名仍为 `eval_input_data_server`。

远端服务通过 `nohup` 等价的独立进程常驻，PID 在 `service.pid`，输出在 `service.log`。归档监听随服务启动；每 5 秒检查一次，每个新增或变化的包独立稳定 30 秒后处理，不再重放无变化的包。每包成功发布后立即登记文件元数据；坏包记录失败，文件未变化时不会反复尝试。其他包继续上传不会丢弃已经处理的包。

已成功登记、文件元数据未变化且没有进程持有写入句柄的原包，会自动移动到 `3_processed_archives/YYYY-MM-DD/part-NNNN/`；日期取包文件名中的日期，无该日期时使用文件修改时间的北京时间日期。每卷最多 50 个原包、累计 2 GiB；单个原包超过 2 GiB 时独占一卷并在巡检中报告。只在同文件系统移动，保留原文件名和内容；同名补传进入下一卷，不覆盖旧包。未处理、继续变化或处理失败的包留在输入目录。归档不改写分日 JSONL、记录索引或处理登记；同名包再次上传时仍按元数据变化增量处理。

手动归档整理使用 `python3 app.py --organize-archives`，检查四个来源，整理未分卷或超限的目录；已符合规则的包不移动、不解压。与实时归档共用各自的 `state/archive.lock`，避免同时分卷越界或覆盖。结果写到各自 `state/archive-maintenance.json`，包括检查时间、包数、字节数、分卷数和超大原包。aime/ifind 的归档全量巡检由处理循环每 24 小时执行一次；新数据仍按原频率自动处理。分卷控制目录和单卷体量，不降低历史数据总字节数，不自动删除原包或评测输入。

首次建立 `state/archive-records.sqlite` 时，只读登记已发布 JSONL 的业务标识、日期和归档来源，不重解压旧包、不改写既有文件。后续只合并新包影响的日期和模型；无关 JSONL 与索引保持原样。SQLite 不保存回答正文，仅保存去重索引及待完成发布的文件清单；重启先恢复中断发布，再继续增量处理。`state/` 必须随服务保留，已有数据但归档登记缺失时会明确报错，避免误触发全量重放。

部署后可检查 `/dashboard-data`、`/processing-status`、`state/root-archives.json` 和 `service.log`。看板分别显示收包时间、入库时间、待处理包、异常原因和最近一次归档巡检体量。服务器重启后手动在远端程序目录运行 `nohup python3 app.py >> service.log 2>&1 </dev/null &`，并将新 PID 写入 `service.pid`。

手动登记已经上传的原四路本地权威数据时，在远端使用 `python3 app.py --register-local-import YYYY-MM-DD`；它只验证并索引原四路。日常部署不执行此命令，GPT 新数据通过独立归档监听处理。

本地进度上报示例：

```bash
python3 server_dashboard_ths/progress_bridge.py data/runs/comparison/<run-id>/state.json --once
```

`state/`、`.packages/`、虚拟环境、日志、PID、压缩包和真实输入均不属于仓库源码。看板与完整 JSONL 接口当前公开可访问，服务无鉴权。

## GPT 六路

六路输入为 `a_fast / b_fast / 6_luna` 与 `a_expert / b_expert / 6.1sol`。仅扫描 `gpt/` 直接子级的 `.7z`，不递归扫描原四路或归档目录；允许部分模型分批到达，只有实际发布的模型才标记就绪。成员文件支持 `run_<model>.jsonl`、`<model>.incr数字.jsonl` 和现有 `AA-fast / AA-expert` 命名。平铺 `messages` 和单 trace 格式均保留支持，`6.1sol` 的点号不变。实际采集文件的 `GPT-luna` 映射到 `6_luna`，`GPT-sol` 映射到 `6.1sol`，同样支持 `.incr数字` 后缀。GPT 消息中的 `span` 作为原始消息完整保留，最终回答仍取最后的 assistant 文本；日期支持 `meta.ask_time` 毫秒时间戳。GPT 按 `meta.testset_name` 中声明的测试集日期分日，缺少测试集日期时才按请求时间分日；`batch_id` 缺省使用分日日期，保持取数方按日期筛选的契约，原始请求时间与采集元数据保持原样。这样跨日采集的同一测试集仍能配对；原四路规则不变。

两套数据集共用进程和端口，各有监听线程；GPT 的处理登记、SQLite 业务索引、记录偏移索引和评测进度全部存于 `0_process_code/state/gpt/`。原四路的路径、状态、去重范围和进度保持独立，不复制或重建旧数据。

六路取数使用 `/gpt/dashboard-data`、`/gpt/dates`、`/gpt/data/<date>/<model>.jsonl`；样本页、处理状态 `/gpt/processing-status` 和文档同样带 `/gpt` 前缀。看板在 Fast、Expert 内分别展示三组两两对战，共六组，缺少输入时显示等待数据。`/gpt/evaluation-progress` 接收六个实际模型对的独立计数；键名为两个模型 ID 按字典序排列后用 `__vs__` 连接，例如 `6_luna__vs__a_fast`。不合并为原四路的 `fast / expert` 计数。

评测端使用 [automations-six-models.example.json](../configs/automations-six-models.example.json)，其 `sourceUrl` 为 `http://117.50.195.94:2256/gpt`；下载与进度上报自动保留该前缀。此部署不启动评测。手动上报已有六路运行时指定：

```bash
python3 server_dashboard_ths/progress_bridge.py data/runs/comparison/<run-id>/state.json \
  --endpoint http://117.50.195.94:2256/gpt/evaluation-progress --once
```

## aime / ifind 数据源

这是 `/mnt/fin_bench/multi_agent_eval` 下的两个数据源，复用增量发布引擎和现有 2256 服务进程，各自有独立处理线程、状态与数据目录。不处理 `0_wencai`，原四路、六路的输入和已处理数据保持原样。服务只准备输入和展示上报进度，不启动评测模型。

```text
/mnt/fin_bench/multi_agent_eval/
  0_process_code/                         仅保留 aime/ifind 处理状态
    state/aime/                          增量登记、业务索引、就绪标记和巡检状态
    state/ifind/
  1_aime/
    1_7z_data/*.7z                       新收到的 aime 包
    0_archive/YYYY-MM-DD/part-NNNN/*.7z   处理成功的原包
    2_daily_eval_input/aime_fast/YYYY-MM-DD.jsonl
    2_daily_eval_input/aime_expert/YYYY-MM-DD.jsonl
  2_ifind/
    1_7z_data/*.7z                       新收到的 ifind 包
    0_archive/YYYY-MM-DD/part-NNNN/*.7z
    2_daily_eval_input/ifind_normal_agent/YYYY-MM-DD.jsonl
    2_daily_eval_input/ifind_deep_research/YYYY-MM-DD.jsonl
```

新包每 5 秒检测，独立稳定 30 秒后增量处理。只处理新增或大小/修改时间有变化的包；失败包未变化时不重试。成功发布后自动归档，每个分包目录最多 **100 个 `.7z`**，累计 2 GiB；单个超大原包独占一卷。保留原包文件名、内容和元数据，同名补传进入下一卷。文件夹中的已处理原包不重复解压。

每日归档巡检直接在 `processing_loop` 中执行，不依赖 Codex 自动化、系统 cron 或人工登录。各数据源的上次巡检时间持久化在自己的 `archive-maintenance.json`，每 24 小时整理一次归档；重启后按该时间判断是否到期。新包仍实时自动处理和归档。

aime / ifind 的新 `meta + traces` 格式按 **session** 处理：一行保留完整会话，所有 trace、消息、轮次元数据和原顺序不裁剪、不拼接；即使部分轮次为空，也不会在有效会话中丢掉这些轮次。会话至少有问题和一个有效回答才入库，整会话采集失败或结构无效会跳过。模式使用会话声明的 agent mode，缺失时才使用 session type 或唯一 trace mode；Fast/Expert 分档不拆分会话。旧 `messages` 记录与 ifind 外层数组继续按现有规则处理。**已发布数据与已处理登记不迁移、不重放**，此规则只作用于后续新增或变化的包。

输出日期取请求时间的北京时间日期，不使用上传包名日期。过滤采集失败、无日期、无身份、无问题或空最终回答的记录；跳过原因记在 `service.log`。旧消息记录优先使用 `case_id / item_id / question_id`，缺失时使用 trace/session ID 和轮次；新会话以 session ID 确定身份，原始 meta 和 traces 保留；同来源、模式、日期/批次和 case ID 去重，较新包的有效记录可替换相同业务标识。输出 `version` 等于模式目录名，保留真实包、成员、行号和外层数组项的 `_source` 坐标。

较大的 JSONL 逐行解析，解压与会话/回答正文暂存在服务器临时盘，不在数据挂载目录另存一份；正文只在本次处理的临时文件中，内存只保留身份与偏移；发布完清理临时文件。启动时先恢复已持久登记的中断发布，再清理本流程遗留的临时盘解压、规范化缓存和未登记输出暂存文件，防止异常退出后临时材料堆积；正式 JSONL 与索引不清理。持久 SQLite 只存身份与发布恢复清单，不再保存一份回答正文。只改写受影响的模式和日期；已成功数据不因包删除或变坏而回撤。

使用同一个 `python3 server_dashboard_ths/deploy.py` 部署并重启 2256；程序、PID 和 `service.log` 仍在原来的 `/mnt/fin_bench/A_AA_comparision_data/0_process_code`。不启动第二个服务，不需要定时任务。

看板入口为 `/aime/`、`/ifind/`，顶部四个数据源可直接切换。两个新来源分别显示 Fast 和 Expert 的输入条数、问句/回答，以及标准制定、归因、聚类三个阶段的真实上报进度。ifind 的 `normal_agent` 显示为 Fast，`deep_research` 显示为 Expert；模型 ID 保留原始模式语义。三个阶段均按实际任务计数，不用输入记录数充当任务分母，不显示对战额度或配对逻辑。没有上报数据时显示“暂无进度”；数据入库不等于评测完成。原四路和 GPT 的对战显示不变。

取数接口与原服务同形，分别加 `/aime`、`/ifind` 前缀；支持 `/dashboard-data`、`/dates`、`/data/{date}/{model}.jsonl`、`/records`、`/processing-status`。进度接口及上报示例见 [服务文档](docs/handoff.md#aime-ifind)。


## 样本浏览

样本表格使用单行预览和统一行内对齐：问句在当前列宽内能放下时直接显示，仅超出时提供同排展开按钮，展开后保留完整原文与换行；调整窗口宽度会重新判断截断状态。回答默认显示去除 Markdown 标记的单行原文概览，展开入口与概览同排，展开后渲染完整 Markdown。问句和回答可独立展开、收起。Trace ID 与复制按钮紧邻同排；过长标识省略显示，悬停可查看全文，复制始终保留完整值。目录页的三阶段进度并排排列，窄屏自然换行。

样本页使用同一张表格分列展示序号、存储格式、Trace ID、问句和回答。平铺消息标为“单 trace”；含 traces 的记录标为 Session，并显示轮数和 Session ID，每轮独立显示真实 Trace ID。标识支持复制，HTTP 页面也可使用；原记录没有标识时明确显示“未提供”，不从会话 ID 猜测 Trace ID。回答和标准答案默认折叠，首次展开后按 Markdown/GFM 渲染标题、列表、引用、代码块、表格与安全链接；原始 HTML 作为文本显示，危险 URL 不生成链接。此功能仅扩展样本 API 的显示字段，不改写存储数据或重处理原包。
