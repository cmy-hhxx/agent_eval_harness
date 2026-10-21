# 远程评测数据服务

原四路看板：<http://117.50.195.94:2256/>　·　GPT 六路看板：<http://117.50.195.94:2256/gpt/>　·　文档：<http://117.50.195.94:2256/docs>

## 远端目录 {#remote-paths}

服务器挂载根目录：`/mnt/fin_bench/A_AA_comparision_data`（保留现名）

源码在代码仓库根目录 `server_dashboard_ths/`；服务所在服务器为根目录 `.servers.conf` 的 `eval_input_data_server`。连接配置与密钥不入库，部署和本地验证见该目录的 `README.md`。

```text
0_process_code/                 服务程序、页面、文档、依赖和状态
*.7z                            新收到或持续增长的原始压缩包（只扫描根目录）
1_raw_zip_data/                 旧目录；不再扫描，也不决定看板日期
2_eval_data_input/<model>/      按请求日期处理后的 JSONL
3_processed_archives/<包日期>/part-NNNN/  已处理原包，按日期和容量分卷
gpt/*.7z                        独立的 GPT 六路新包
gpt/2_eval_data_input/<model>/   GPT 六路按请求日期处理后的 JSONL
gpt/3_processed_archives/<包日期>/part-NNNN/  GPT 已处理原包
0_process_code/state/gpt/       GPT 独立处理登记、业务索引、偏移索引和评测进度
```

根目录保留原四路：`a_fast`、`b_fast`、`a_expert`、`b_expert`。GPT 六路放在 `gpt/` 内，额外包含 `6_luna`、`6.1sol`，详见“六路评测输入”。两套输入、分日输出、归档与状态各自独立，原四路不因六路接入而重建或重新导入。每份输出为 `<model>/<date>.jsonl`，不使用 `_daily`。看板日期由各自已发现的输出文件、就绪状态和当前评测进度日期动态生成，不预建固定日期窗口；标题范围随最早和最新日期自动变化。

## 历史数据与新增输入 {#inputs}

本地已有的 `2026-09-22` 至 `2026-09-25` 四模型 JSONL 已同步至 `2_eval_data_input`，约 7.85 GB。根目录中的 `.7z` 成员可使用 `_A-fast.jsonl`、`_AA-fast.jsonl`、`_A-expert.jsonl`、`_AA-expert.jsonl`，也可带 `.incrNNNNN` 后缀；单个包允许只含部分模型。`AA` 成员名会规范化到 `b_fast`、`b_expert`，所有输出目录、索引目录和 API 模型 ID 均使用 `b_*`。新压缩包直接放在服务根目录，不再放入 `1_raw_zip_data`。

新采集器的 `meta + traces` 输入按单轮测试集处理：`traces` 必须恰好有一个 trace，其 `messages` 原序展开到顶层，供现有看板与评测端读取；输出不重复保存 `traces`。trace 元数据与外层 `meta` 合并，外层字段优先；顶层 `trace_id` 使用 trace 的真实标识，外层 session 信息保留。原有请求时间与 `meta.ask_time` 均缺失时，用 `trace.meta.timestamp` 按北京时间确定日期。空 trace、多 trace、无效结构分别计入跳过日志，避免误取任意轮次。原顶层 `messages` 输入继续使用原处理规则，已发布文件不需要迁移。

服务按记录内的 `request_time` 或 `meta.request_time` 的北京时间日期分组；缺少这两个字段时，用 `meta.ask_time`（Unix 毫秒）按北京时间兜底。无法确定日期、JSON 无效、采集失败、消息类型不支持、缺少问题/身份或最终回答为空的记录会跳过，不写入 `2_eval_data_input`；跳过数量汇总写入 `0_process_code/service.log`。每行开头固定输出 `request_time`、`has_standard_answer`、`versions` 三个顶层字段；扩展字段在 `app.py` 的 `TOP_LEVEL_FIELD_ORDER` 与 `top_level_fields()` 集中维护。看板显示为 B组 Fast（内部模型 ID `b_fast`）在请求日期 `2026-09-29` 及之后使用 `versions: "0929-big-fast"`，其他模型/日期使用 `"default"`。

服务每 5 秒检查根目录 `.7z` 的文件名、大小和修改时间。每个新增或变化的包独立等待 30 秒稳定后处理，只读取这些包；已登记且未变化的包不再解压。每个包发布后立即把文件元数据写入 `state/root-archives.json`；其他包继续上传不会丢弃当前包的结果，当前包自身变化时只延后该包。无法读取或没有可识别模型 JSONL 的包记录失败，未变化时不重试，文件变化后再处理。

成功登记且稳定的原包在没有进程持有写入句柄时，自动移动至 `3_processed_archives/YYYY-MM-DD/part-NNNN/<原文件名>`；按包文件名中的日期分目录，文件名没有日期时按修改时间的北京时间日期归档。每卷最多 50 包、累计 2 GiB；单包超过 2 GiB 时独占一卷并在巡检报告中列出。同名补传使用下一卷并保留原名，不覆盖既有原包。失败、尚未处理或仍在写入的包保留在输入目录。归档目录不参与输入扫描；处理登记、业务标识及 `_source.original_file` 保留原归档名，分日输出和记录索引保持原样。再次上传同名包，元数据变化时继续增量合并。

手动归档巡检执行 `python3 app.py --organize-archives`，只整理已有归档，不解压、不重放或删除原包，不修改评测输入。历史未分卷目录和超限分卷会整理，符合规则的文件保持原样。两套数据集分别用 `state/archive.lock` 协调实时归档，报告写入各自的 `state/archive-maintenance.json`。分卷控制单目录和单卷体量；历史数据总占用仍随真实来包增长。

合并以来源 ID、模型、`batch_id`、`case_id` 为业务标识。相同 16 位十六进制来源 ID 下，归档文件名较新、同包 `.incrNNNNN` 序号较大的有效记录优先；不同来源 ID 的重复记录分别保留。更新相同业务标识时，替换该条记录，必要时随修正后的请求日期移动；同名包减少记录、变坏或被删除不会回撤此前已经接受的有效数据。原始来源 `_source` 始终由实际归档文件和成员名确定，不采用输入自报的归档来源。

`state/archive-records.sqlite` 仅保存业务标识、日期和来源，不重复保存回答正文。索引首次初始化时只读已有的完整分日输出，不重解压已登记包、不改写历史 JSONL。后续只重新写入受影响日期/模型的 JSONL 和字节偏移索引，无关日期和模型保持原样；本地权威导入日（当前 2026-09-22 至 25）继续保留，重叠记录计入 `local_import_overlap`。发布前先持久化待完成文件清单及索引变更，文件准备完成后切换就绪标记并登记包；中断后优先继续完成发布，不重复追加或重新解压该包。部署保留整个 `state/`；已有分日数据却缺失归档登记时明确报错，避免重新处理全部历史包。

`1_raw_zip_data` 内的旧压缩包不再扫描。若需要纳入本地权威日期的归档记录，先将该日期迁移为完整归档来源再处理。

## 看板 {#dashboard}

访问 <http://117.50.195.94:2256/>，用顶部“原四路 / GPT 六路 / 后训练模型评测 / aime / ifind”切换数据集。状态栏显示最近收包、入库时间（北京时间）、待处理和异常包，可展开原始错误；归档体量和分卷数取最近一次每日巡检报告，不在刷新页面时扫描全部原包。日期表每页展示最新 14 天，可翻页查看更早日期。原四路每行分别列出 Fast、Expert 两对；GPT 在每档展示三对。点击模型条数进入样本表格；单 trace / Session、会话轮数、Trace ID、问句和回答分列展示，Trace ID 与 Session ID 可复制。每轮回答与可用标准答案默认折叠，展开后按 Markdown/GFM 渲染，不返回或渲染中间消息。样本 API 增加 `format`（`trace` 或 `session`）、`session_id`，单条和各轮带 `trace_id`；缺失的标识返回 null，不用 Session ID 替代 Trace ID。Session 的 `turns` 仍按原顺序返回。页面每 15 秒刷新，也可手动刷新；处理状态查询失败不会把可用的数据目录标成离线。

评测进度由独立脚本 `progress_bridge.py` 读取一个或多个本地运行的 `state.json` 并上报，不修改当前评测器流程。可传入不同日期的多个 run 文件以合并显示。每条日期/对战组显示已完成数、未配对数和真实评测失败数；全成功时用 ✅ 标记，不显示成功比例分母。成功的 Comparison 任务计完成，失败、超时、取消、阻塞计真实失败，预检跳过单独计数。样本按 `batch_id + case_id` 在日期和对战组内去重；统计整个 run 的 Comparison 状态，不受 `executionScope` 子集限制；Rewrite 与 clustering 不计入。默认每 10 秒检查，运行状态文件超过 60 秒未更新时显示“进度停更”。

## HTTP 接口 {#api}

样本表格统一使用单行预览，问句、回答、标识按同一行高对齐。短问句直接显示，仅超过当前列宽的问句提供同排展开按钮；窗口宽度变化时重新判断。回答默认展示去除 Markdown 标记的单行原文概览，展开入口与概览同排，展开后渲染完整 Markdown，可与问句独立展开、收起。Trace ID 和复制按钮紧邻同排，过长标识悬停查看全文，始终复制完整值。单 trace 行仅在标识列显示 Trace ID，Session 记录另外显示会话 ID 和逐轮标识。

Fast、Expert 两列均标明“每天最多评测 300 次对战”和“超过评测配额，不评测”。排队仅展示额度内剩余对战，包含单列提示的失败待重试项；配对充足时已完成、运行中与排队合计为 300，不足时保留实际数量。已完成超过 300 的日期显示“历史已完成”并保留真实完成数，不再增加排队；上报快照仍含超额队列时，另列其“超过评测配额，不评测”数量。此处只影响显示，不改变任务状态和上传接口。

配对只有在运行、排队、失败均为零且完成加跳过等于已上报总数时，才进一步判断是否完成。已完成达到每档 300 次时显示 ✅，含义是“当日评测额度已完成”，后来新增数据不再进入该档额度。未达额度时核对当前远端目录：输入条数超过旧进度覆盖数显示“有新增待评测”，减少时显示“数据已变化”，未就绪显示“数据准备中”，仍有缺配对显示“等待配对”；这些状态不显示 ✅。未达额度且当前输入已全部评测时显示 ✅，全部为预检跳过时显示“无可评测样本”。目录行数不等于已配对任务数，不据此虚构排队数量。已经完成当前数据或当日额度的配对不受其他日期运行状态影响。

服务内部监听 `8081`，外部端口映射为 `2256`。不做鉴权。

- `GET /health`：服务状态。
- `GET /dashboard-data`：看板数据，包括每个日期/模型的 `ready`、`row_count` 和按日期及 Fast/Expert 配对汇总的当前评测进度。
- `GET /processing-status`：最近收包/入库时间、待处理数量、失败包与错误、最近一次归档巡检；查询异常用 `error` 返回，不伪报零值。
- `GET /dates`：已完整处理、可取数的日期与模型。
- `GET /data/{date}/{model}.jsonl`：下载完整 JSONL，模型名为 `a_fast`、`b_fast`、`a_expert`、`b_expert`。
- `GET /records?date=...&model=...`：样本查看页。
- `GET /records/{date}/{model}?page=1&page_size=20`：分页读取问句、最终回答和标准答案（若有），响应不含中间消息。
- `POST /evaluation-progress`：更新当前/最近一次评测标记。
- `GET /docs`：浏览器版文档；`GET /docs/handoff.md`：原始 Markdown。

进度 POST 使用 `application/json`，请求上限为 1 MiB，时间戳为毫秒。`dates` 按输入源文件名中的日期分组；每个日期包含 `fast`（A Fast 对 B组 Fast）和 `expert`（A Expert 对 B组 Expert）两组计数。样本在日期和对战组内按 `batch_id + case_id` 去重；计数只基于 Comparison 任务。`skipped_cases` 单独记录预检未能配对的样本，不算作评测失败；`total_cases - skipped_cases` 是可评测总数。

```json
{
  "run_id": "pi-2026-09-29",
  "engine": "pi",
  "status": "running",
  "started_at": 1790683200000,
  "updated_at": 1790683200000,
  "dates": [
    {
      "date": "2026-09-22",
      "pairs": {
        "fast": {
          "total_cases": 100,
          "completed_cases": 12,
          "running_cases": 4,
          "queued_cases": 80,
          "failed_cases": 1,
          "skipped_cases": 3
        },
        "expert": {
          "total_cases": 0,
          "completed_cases": 0,
          "running_cases": 0,
          "queued_cases": 0,
          "failed_cases": 0,
          "skipped_cases": 0
        }
      }
    }
  ]
}
```

`status` 允许 `running`、`finished`、`interrupted`。只保留最近启动的运行；旧运行迟到的更新会被拒绝。可独立启动本地上报脚本：

```bash
python3 server_dashboard_ths/progress_bridge.py \\
  data/runs/comparison/daily-2026-09-22/state.json \\
  data/runs/comparison/daily-2026-09-23/state.json \\
  data/runs/comparison/daily-2026-09-24/state.json \\
  data/runs/comparison/daily-2026-09-25/state.json --once
```

`GET /dates` 仍是 JSON 数据接口；根路径 `/` 用于看板。

取数示例：

```bash
curl -f http://117.50.195.94:2256/dates
curl -f -o 2026-09-22.jsonl \
  http://117.50.195.94:2256/data/2026-09-22/a_fast.jsonl
```

数据接口按 1 MiB 分块流式返回，不会将整份 JSONL 载入内存。日期未就绪时不会出现在 `/dates`，直接请求返回 404。

## 运行维护 {#operations}

服务在远端 `0_process_code/` 下以 `nohup` 常驻，SSH 断开后仍运行；日志为 `service.log`。服务器重启或进程退出后需手动启动：

```bash
cd /mnt/fin_bench/A_AA_comparision_data/0_process_code
nohup python3 app.py >> service.log 2>&1 </dev/null &
echo $! > service.pid
```

## 安全与当前状态 {#status}

看板、文档、进度更新和数据接口均可通过公网访问，无鉴权。看板不展示下载入口，但完整 JSONL 下载 API 仍可公开访问并包含原始消息链路；样本查看页只渲染问句、最终回答和标准答案。当前日期列表由服务端的数据文件、就绪状态和评测进度动态决定；访问 `/dashboard-data` 查看看板目录，访问 `/dates` 查看完整就绪日期。

## 六路评测输入

GPT 六路按同档两两对战：Fast 为 `a_fast / b_fast / 6_luna`，Expert 为 `a_expert / b_expert / 6.1sol`；每档三对，共六对，不跨档比较。看板入口 `/gpt/`，保留日期分页、各路条数及问句浏览，并逐对显示评测进度。

原始包直接放在 `/mnt/fin_bench/A_AA_comparision_data/gpt/*.7z`。只扫描该目录直接子级，不递归读原四路或归档；每个包独立稳定 30 秒后增量处理，成功后移至 `gpt/3_processed_archives/YYYY-MM-DD/part-NNNN/`。输出写入 `gpt/2_eval_data_input/<model>/<date>.jsonl`。允许部分模型分批上传，仅实际发布的模型标记就绪；没有该模型数据时 API 返回 404，页面显示等待数据，不伪造空文件。

处理登记、SQLite 业务索引、就绪标记、偏移索引与进度全部位于 `0_process_code/state/gpt/`。同名包、相同业务 ID 在原四路和 GPT 中分别处理；GPT 的新增、补传、归档和重启恢复不会覆盖原四路。去重优先级、有效行过滤、北京时间日期、单 trace 规则沿用上文，两套数据集各自执行。

压缩包成员识别 `<model>.jsonl`、`run_<model>.jsonl` 及 `.incr数字.jsonl`，可位于包内子目录；保留 `6.1sol` 中的点号。实际采集文件的 `GPT-luna` 映射到 `6_luna`，`GPT-sol` 映射到 `6.1sol`，同样支持 `.incr数字` 后缀。GPT 消息中的 `span` 作为原始消息完整保留，最终回答仍取最后的 assistant 文本；日期支持 `meta.ask_time` 毫秒时间戳。GPT 的分日日期优先取 `meta.testset_name` 中的测试集日期；未声明日期则沿用请求时间。缺省 `batch_id` 使用分日日期，保持取数方按日期筛选的契约，保留真实 `request_time / ask_time`，不会因为 GPT 晚几天采集而拆散同一测试集。原四路与 aime/ifind 不应用此规则。继续接受 `AA-fast / AA-expert` 成员名并映射为 `b_fast / b_expert`；输出行内 `version` 为 `A Fast / B Fast / A Expert / B Expert / 6_luna / 6.1sol`，不保留 `AA Fast` 显示名。支持 OpenAI 消息或显式轮次，原消息不转换，评测端 adapter 须与实际格式匹配。

六路 HTTP 接口与原四路同形，但全部带 `/gpt` 前缀：

- `GET /gpt/health`、`GET /gpt/dashboard-data`、`GET /gpt/dates`、`GET /gpt/processing-status`。
- `GET /gpt/data/{date}/{model}.jsonl`：仅下载 GPT 数据。
- `GET /gpt/records?date=...&model=...` 和 `GET /gpt/records/{date}/{model}?page=1&page_size=20`。
- `POST /gpt/evaluation-progress`：相同六个计数字段，`pairs` 使用独立模型对键，可只上报已配置的对；未知模型对拒绝。所有来源的进度接口请求上限统一为 1 MiB，可容纳原四路的累计多日期快照；字段校验与来源隔离保持不变。

六个键为 `a_fast__vs__b_fast`、`6_luna__vs__a_fast`、`6_luna__vs__b_fast`、`a_expert__vs__b_expert`、`6.1sol__vs__a_expert`、`6.1sol__vs__b_expert`。均按模型 ID 字典序连接，不将三对累计到原 `fast / expert`。页面每对独立显示 300 次每日对战额度及其完成状态；统计上传日志结构保持不变。

六路客户端配置 `sourceUrl = http://117.50.195.94:2256/gpt`，下载和上报自动保留前缀，示例在仓库 `configs/automations-six-models.example.json`。手动进度桥接指定 `--endpoint http://117.50.195.94:2256/gpt/evaluation-progress`；按实际两名候选输入统计，不把三模型组的一次任务算成三场。服务监听只处理输入、不启动评测。


## aime / ifind {#aime-ifind}

两个来源接入同一个 2256 服务，分别使用 `/aime/`、`/ifind/` 看板。原始包读取 `/mnt/fin_bench/multi_agent_eval/1_aime/1_7z_data/*.7z`、`2_ifind/1_7z_data/*.7z`；不读取 `0_wencai`。处理结果写到各自的 `2_daily_eval_input/<model>/<date>.jsonl`，成功原包移到各自的 `0_archive/YYYY-MM-DD/part-NNNN/`。状态放在 `/mnt/fin_bench/multi_agent_eval/0_process_code/state/{aime,ifind}`；服务程序和日志仍在原四路的 `0_process_code`，不另起服务。

每个新包稳定 30 秒后增量处理；未变化的已登记包不重新解压。每卷最多 100 个 `.7z`、2 GiB，单个超大包独占一卷。每日归档巡检写在处理循环中，每 24 小时检查一次；不依赖 Codex 自动化或系统 cron。请求时间按北京时间分日，不按压缩包上传日期分日；实际消息保留，空回答、采集失败或缺失必要字段会记录跳过原因。

模型 ID 为 `aime_fast`、`aime_expert`、`ifind_normal_agent`、`ifind_deep_research`。ifind 普通模式显示为 Fast，深研模式显示为 Expert。会话按 `agent_mode` 分档，缺失时取 `session_type`，再用唯一 trace mode 兜底；ifind 仍未确定模式时可取包名或成员名中的模式，文件名声明与会话模式冲突则拒绝。不把同一会话拆到多个模式。旧消息输入与 ifind 外层数组沿用既有处理规则。

新 `meta + traces` 输入以 session 为单位，一行保存完整会话，原 meta、各轮 trace 和 messages 按原顺序完整保留；不再限制只能一个 trace，也不拼接消息或只取末轮。若部分轮次没有回答，仍保留在有效会话内；仅整会话采集失败、结构无效、完全没有问题或完全没有有效回答时跳过。规范化 `case_id` 优先使用 `meta.session_id`，缺失时才用原业务 case ID（单 trace 可用 trace ID）；同来源、模式、批次、会话身份去重。日期取会话请求时间，缺失时使用 trace 时间兜底。所有原始采集元数据保留供后续评测方式调整。

已发布的旧记录和已处理包登记保持原样；后续新增或变化的包才使用当前处理逻辑。看板条数是 JSONL 记录数：新会话一行计一条，不按 trace 数膨胀；样本页显示会话内每轮问答，回答默认折叠。旧记录仍按原问答展示。

`GET /aime/dashboard-data` 与 `/ifind/dashboard-data` 返回各自的日期与模型条数；`/dates`、`/data/{date}/{model}.jsonl`、`/records`、`/processing-status` 同样带对应前缀。模型允许单独到达；另一模式缺失不阻止已就绪输入下载。

两个来源没有对战逻辑，展示标准制定、归因、聚类阶段。`POST /{source}/evaluation-progress` 使用和原进度相同的 run 字段，但每个日期为 `{date, models}`，不用 `pairs`。`models` 键限于本来源模型 ID，每个模型必须包含 `criteria`、`attribution`、`clustering`；每阶段为 `{total, completed, running, pending, failed, blocked, cancelled}`，全部为非负整数，后六项之和等于 total。三个阶段都按实际任务计数，不把输入行数、会话数或轮次数当作任务总数。请求上限 1 MiB，迟到旧快照拒绝，独立于原四路和 GPT 进度。

本地有真实 Host 检查点时可使用以下脚本上报；脚本只读状态，不启动或修改评测：

```bash
python3 server_dashboard_ths/progress_bridge.py data/runs/comparison/<run-id>/state.json \
  --endpoint http://117.50.195.94:2256/aime/evaluation-progress --once
```

ifind 使用 `/ifind/evaluation-progress`。只统计运行执行范围内的三个阶段，去重相同任务 ID；成功状态且存在接受回执才计完成。无进度上报时显示“暂无进度”，入库不伪造评测结果。

## 后训练模型评测

服务器目录 `post_training_model/` 与原四路、GPT 隔离；输入为 `a_fast / b_fast / b_post_train_fast`，看板和全部接口使用 `/post_training_model` 前缀。上传 `.7z` 到该目录直接子级；成员文件名及当前后训练版本映射见[后训练输入说明](../README.md#后训练模型评测)。A 沿用 A 格式，后两路沿用 B 格式。后训练输出 version 为 `B post_train_fast`。

日期优先取 `meta.testset_name` 的唯一测试集日期，缺失时使用北京时间请求日期；三路同题须有相同 case_id 和 batch_id。各模型分批到达时独立就绪，自动评测等待三路齐备。分日输出在 `post_training_model/2_eval_data_input/<model>/<date>.jsonl`，原包在成功处理后移动到本来源的 `3_processed_archives/<包日期>/part-NNNN/`，状态在 `0_process_code/state/post_training_model/`；重启沿登记恢复，不重放历史包。

进度字段与六路一致，模型对仅为 `a_fast__vs__b_fast`、`a_fast__vs__b_post_train_fast`、`b_fast__vs__b_post_train_fast`；拒绝其他对战键，不将三对合并成 `fast`。处理与进度状态均独立保存，默认随统一数据服务监听。
