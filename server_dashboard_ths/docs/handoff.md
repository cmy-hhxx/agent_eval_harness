# 远程评测数据服务

看板：<http://117.50.195.94:2256/>　·　文档：<http://117.50.195.94:2256/docs>

## 远端目录 {#remote-paths}

服务器挂载根目录：`/mnt/fin_bench/A_AA_comparision_data`（保留现名）

源码在代码仓库根目录 `server_dashboard_ths/`；服务所在服务器为根目录 `.servers.conf` 的 `eval_input_data_server`。连接配置与密钥不入库，部署和本地验证见该目录的 `README.md`。

```text
0_process_code/                 服务程序、页面、文档、依赖和状态
*.7z                            新收到或持续增长的原始压缩包（只扫描根目录）
1_raw_zip_data/                 旧目录；不再扫描，也不决定看板日期
2_eval_data_input/<model>/      按请求日期处理后的 JSONL
```

四个模型目录为 `a_fast`、`b_fast`、`a_expert`、`b_expert`。每份输出为 `<model>/<date>.jsonl`，不使用 `_daily`。看板日期由已发现的输出文件、就绪状态和当前评测进度日期动态生成，不预建固定日期窗口；标题范围随最早和最新日期自动变化。新增日期来自根目录压缩包解析出的请求时间，评测进度上报也可带来尚无数据文件的日期行。

## 历史数据与新增输入 {#inputs}

本地已有的 `2026-09-22` 至 `2026-09-25` 四模型 JSONL 已同步至 `2_eval_data_input`，约 7.85 GB。根目录中的 `.7z` 成员可使用 `_A-fast.jsonl`、`_AA-fast.jsonl`、`_A-expert.jsonl`、`_AA-expert.jsonl`，也可带 `.incrNNNNN` 后缀；单个包允许只含部分模型。`AA` 成员名会规范化到 `b_fast`、`b_expert`，所有输出目录、索引目录和 API 模型 ID 均使用 `b_*`。新压缩包直接放在服务根目录，不再放入 `1_raw_zip_data`。

新采集器的 `meta + traces` 输入按单轮测试集处理：`traces` 必须恰好有一个 trace，其 `messages` 原序展开到顶层，供现有看板与评测端读取；输出不重复保存 `traces`。trace 元数据与外层 `meta` 合并，外层字段优先；顶层 `trace_id` 使用 trace 的真实标识，外层 session 信息保留。原有请求时间与 `meta.ask_time` 均缺失时，用 `trace.meta.timestamp` 按北京时间确定日期。空 trace、多 trace、无效结构分别计入跳过日志，避免误取任意轮次。原顶层 `messages` 输入继续使用原处理规则，已发布文件不需要迁移。

服务按记录内的 `request_time` 或 `meta.request_time` 的北京时间日期分组；缺少这两个字段时，用 `meta.ask_time`（Unix 毫秒）按北京时间兜底。无法确定日期、JSON 无效、采集失败、消息类型不支持、缺少问题/身份或最终回答为空的记录会跳过，不写入 `2_eval_data_input`；跳过数量汇总写入 `0_process_code/service.log`。每行开头固定输出 `request_time`、`has_standard_answer`、`versions` 三个顶层字段；扩展字段在 `app.py` 的 `TOP_LEVEL_FIELD_ORDER` 与 `top_level_fields()` 集中维护。看板显示为 B组 Fast（内部模型 ID `b_fast`）在请求日期 `2026-09-29` 及之后使用 `versions: "0929-big-fast"`，其他模型/日期使用 `"default"`。

服务每 5 秒检查根目录 `.7z` 的文件名、大小和修改时间，变化后等待 30 秒稳定再处理。处理期间若源文件变化，会丢弃该快照；若同名压缩包数小时后继续增长，会重新读取根目录中的全部 `.7z`，按日期重建 JSONL 和索引，而不是追加旧输出，因此续跑不重复累加。重建期间继续展示上一份完整快照；就绪状态由分日 JSONL 与索引是否匹配决定，归档签名只用于判断是否需要重建，不会让已有数据暂时消失。同一 16 位十六进制来源 ID 下，归档按新到旧、成员按增量序号从高到低读取；相同模型、batch、case 的较新有效记录覆盖旧记录，其他不同来源 ID 的重复记录保留。无法读取或没有可识别模型 JSONL 的包会记入失败状态，其他可读片段仍处理；失败归档在文件签名变化或服务重启后重试，同一进程不会对未变化的失败快照反复解压。`1_raw_zip_data` 内的旧压缩包不再扫描。`local_import` 日期（当前 2026-09-22 至 25）保留现有数据；归档中落入这些日期的记录跳过并计入 `local_import_overlap`，其他日期正常重建。若需要纳入重叠日期的归档记录，先将该日期迁移为完整归档来源再处理。

## 看板 {#dashboard}

访问 <http://117.50.195.94:2256/> 查看按日期排列的表格；每页展示最新 14 天，可翻页查看更早日期。每行分别列出 A Fast 对 B组 Fast、A Expert 对 B组 Expert 的数据条数和评测进度。点击模型条数进入问句列表；回答与可用的标准答案默认折叠，不返回或渲染中间消息。看板不提供下载入口；完整 JSONL 下载 API 保留。页面每 15 秒刷新，也可手动刷新。

评测进度由独立脚本 `progress_bridge.py` 读取一个或多个本地运行的 `state.json` 并上报，不修改当前评测器流程。可传入不同日期的多个 run 文件以合并显示。每条日期/对战组显示已完成数、未配对数和真实评测失败数；全成功时用 ✅ 标记，不显示成功比例分母。成功的 Comparison 任务计完成，失败、超时、取消、阻塞计真实失败，预检跳过单独计数。样本按 `batch_id + case_id` 在日期和对战组内去重；统计整个 run 的 Comparison 状态，不受 `executionScope` 子集限制；Rewrite 与 clustering 不计入。默认每 10 秒检查，运行状态文件超过 60 秒未更新时显示“进度停更”。

## HTTP 接口 {#api}

Fast、Expert 两列均标明“每天最多评测 300 次对战”和“超过评测配额，不评测”。排队仅展示额度内剩余对战，包含单列提示的失败待重试项；配对充足时已完成、运行中与排队合计为 300，不足时保留实际数量。已完成超过 300 的日期显示“历史已完成”并保留真实完成数，不再增加排队；上报快照仍含超额队列时，另列其“超过评测配额，不评测”数量。此处只影响显示，不改变任务状态和上传接口。

配对只有在运行、排队、失败均为零且完成加跳过等于已上报总数时，才进一步判断是否完成。已完成达到每档 300 次时显示 ✅，含义是“当日评测额度已完成”，后来新增数据不再进入该档额度。未达额度时核对当前远端目录：输入条数超过旧进度覆盖数显示“有新增待评测”，减少时显示“数据已变化”，未就绪显示“数据准备中”，仍有缺配对显示“等待配对”；这些状态不显示 ✅。未达额度且当前输入已全部评测时显示 ✅，全部为预检跳过时显示“无可评测样本”。目录行数不等于已配对任务数，不据此虚构排队数量。已经完成当前数据或当日额度的配对不受其他日期运行状态影响。

服务内部监听 `8081`，外部端口映射为 `2256`。不做鉴权。

- `GET /health`：服务状态。
- `GET /dashboard-data`：看板数据，包括每个日期/模型的 `ready`、`row_count` 和按日期及 Fast/Expert 配对汇总的当前评测进度。
- `GET /dates`：已完整处理、可取数的日期与模型。
- `GET /data/{date}/{model}.jsonl`：下载完整 JSONL，模型名为 `a_fast`、`b_fast`、`a_expert`、`b_expert`。
- `GET /records?date=...&model=...`：样本查看页。
- `GET /records/{date}/{model}?page=1&page_size=20`：分页读取问句、最终回答和标准答案（若有），响应不含中间消息。
- `POST /evaluation-progress`：更新当前/最近一次评测标记。
- `GET /docs`：浏览器版文档；`GET /docs/handoff.md`：原始 Markdown。

进度 POST 使用 `application/json`，时间戳为毫秒。`dates` 按输入源文件名中的日期分组；每个日期包含 `fast`（A Fast 对 B组 Fast）和 `expert`（A Expert 对 B组 Expert）两组计数。样本在日期和对战组内按 `batch_id + case_id` 去重；计数只基于 Comparison 任务。`skipped_cases` 单独记录预检未能配对的样本，不算作评测失败；`total_cases - skipped_cases` 是可评测总数。

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
