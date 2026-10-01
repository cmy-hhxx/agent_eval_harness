# 远程评测数据服务交接

本页描述仓库外的取数服务及本地自动化依赖的 HTTP 接口。远端部署、数据就绪日期与脚本不由本仓库管理；运行时状态以远端 `/dashboard-data` 和 `/dates` 为准。本地调度、续跑和上传见[自动化](automations.md)。

看板：<http://117.50.195.94:2256/>　·　文档：<http://117.50.195.94:2256/docs>

## 远端目录 {#remote-paths}

服务器挂载根目录：`/mnt/fin_bench/A_AA_comparision_data`（沿用实际挂载路径；内部模型标识使用 B）

```text
0_process_code/                 服务程序、页面、文档、依赖和状态
*.7z                            新收到或持续增长的原始压缩包（只扫描根目录）
1_raw_zip_data/YYYY-MM-DD/      日期占位目录；不再接收新压缩包
2_eval_data_input/<model>/      按请求日期处理后的 JSONL
```

此服务交接约定的日期范围为 `2026-09-22` 至 `2026-10-07`（含），共 16 天；实际可取日期以 `/dates` 为准。四个模型目录为 `a_fast`、`b_fast`、`a_expert`、`b_expert`。每份输出为 `<model>/<date>.jsonl`，不使用 `_daily`。

## 历史数据与新增输入 {#inputs}

交接时 `2026-09-22` 至 `2026-09-25` 四模型 JSONL 已同步至 `2_eval_data_input`；后续可用性不能依据本页的历史盘点推断。根目录中的每个 `.7z` 应含四类模型 JSONL，文件名后缀为 `_A-fast.jsonl`、`_B-fast.jsonl`、`_A-expert.jsonl`、`_B-expert.jsonl`；新压缩包直接放在服务根目录，不再放入 `1_raw_zip_data`。

服务按记录内的 `request_time` 或 `meta.request_time` 的北京时间日期分组；缺少这两个字段时，用 `meta.ask_time`（Unix 毫秒）按北京时间兜底。无法确定日期、JSON 无效、采集失败、消息类型不支持、缺少问题/身份或最终回答为空的记录会跳过，不写入 `2_eval_data_input`；跳过数量汇总写入 `0_process_code/service.log`。每行开头固定输出 `request_time`、`has_standard_answer`、`versions` 三个顶层字段；扩展字段在 `app.py` 的 `TOP_LEVEL_FIELD_ORDER` 与 `top_level_fields()` 集中维护。`B Fast` 在请求日期 `2026-09-29` 及之后使用 `versions: "0929-big-fast"`，其他模型/日期使用 `"default"`。

服务每 5 秒检查根目录 `.7z` 的文件名、大小和修改时间，变化后等待 30 秒稳定再处理。处理期间若源文件变化，会丢弃该快照；若同名压缩包数小时后继续增长，会重新读取根目录中的全部 `.7z`，按日期重建 JSONL 和索引，而不是追加旧输出，因此续跑不重复累加。打不开或缺少模型文件的压缩包会暂时跳过，其他完整压缩包仍可处理；该文件大小或修改时间变化后会重新尝试。保留所有历史压缩包；每个有效包都需包含四类模型文件。跨包重复业务记录不自动去重，评测预检仍可发现重复。`1_raw_zip_data` 内的旧压缩包不再扫描。`local_import` 日期若与根目录归档按请求时间落入同一天，服务会拒绝覆盖并在日志中说明；迁移完成归档后才能混合处理。

## 看板 {#dashboard}

访问 <http://117.50.195.94:2256/> 查看按日期排列的表格；每行分别列出 A Fast 对 B Fast、A Expert 对 B Expert 的数据条数和评测进度。点击模型条数进入问句列表；回答与可用的标准答案默认折叠，不返回或渲染中间消息。看板不提供下载入口；完整 JSONL 下载 API 保留。页面每 15 秒刷新，也可手动刷新。

Fast、Expert 两列均标明“每天最多评测 600 次对战”和“超过评测配额，不评测”。排队仅展示额度内剩余对战，包含单列提示的失败待重试项；配对充足时已完成、运行中与排队合计为 600，不足时保留实际数量。已完成超过 600 的日期显示“历史已完成”并保留真实完成数，不再增加排队；上报快照仍含超额队列时，另列其“超过评测配额，不评测”数量。此处只影响显示，不改变任务状态和上传接口。

本仓库通过 `automations` 从已登记 run 的 `state.json` 汇总并上报进度（见[日志与进度](automations.md#日志与进度)）；外部上报脚本不在本仓库。每条日期/模型配对只统计 Comparison：`failed` / `timed_out` 计真实失败，`cancelled` / `blocked` 计排队，预检中无法配对的样本计 `skipped_cases`；Rewrite 与 clustering 不计入。样本按 `batch_id + case_id` 在日期和配对内去重；自动化每 10 秒更新本地进度。远端停更展示由远端服务负责。

## HTTP 接口 {#api}

配对状态先根据该日期、该配对的六项计数判断：全部可评测项成功且运行、排队、失败均为零时显示 ✅；全部为预检跳过时显示“无可评测样本”。流水线继续处理其他日期、停机或心跳停更，不会把已经完成的配对重新标为“评测中”。未完成的配对仍按当前运行状态显示。

服务内部监听 `8081`，外部端口映射为 `2256`。不做鉴权。

- `GET /health`：服务状态。
- `GET /dashboard-data`：看板数据，包括每个日期/模型的 `ready`、`row_count` 和按日期及 Fast/Expert 配对汇总的当前评测进度。
- `GET /dates`：已完整处理、可取数的日期与模型。
- `GET /data/{date}/{model}.jsonl`：下载完整 JSONL，模型名为 `a_fast`、`b_fast`、`a_expert`、`b_expert`。
- `GET /records?date=...&model=...`：样本查看页。
- `GET /records/{date}/{model}?page=1&page_size=20`：分页读取问句、最终回答和标准答案（若有），响应不含中间消息。
- `POST /evaluation-progress`：更新当前/最近一次评测标记。
- `GET /docs`：浏览器版文档；`GET /docs/handoff.md`：原始 Markdown。

进度 POST 使用 `application/json`，时间戳为毫秒。`dates` 按输入源文件名中的日期分组；每个日期包含 `fast`（A Fast 对 B Fast）和 `expert`（A Expert 对 B Expert）两组计数。每组必须同时包含以下六个非负整数，即使全部为零也不能省略字段。样本在日期和配对内按 `batch_id + case_id` 去重；计数只基于 Comparison 任务，未配对单独记为 `skipped_cases`，可评测总数为 `total_cases - skipped_cases`。去重时按运行中、真实失败、已成功、预检跳过、排队的顺序归类，已有成功结果不会被另一个 run 的预检跳过覆盖。取消和依赖阻塞最终归入排队，不冒充真实失败。

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

`status` 允许 `running`、`finished`、`interrupted`。远端只保留最近启动的上报者；旧上报者迟到的更新会被拒绝。使用本仓库的上报入口时运行 `bash automation.sh`；也可直接执行 `npm run automations -- run`，配置中的 `publishProgress` 控制是否上报。

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

## 安全与状态核查 {#status}

看板、文档、进度更新和数据接口均可通过公网访问，无鉴权。看板不展示下载入口，但完整 JSONL 下载 API 仍可公开访问并包含原始消息链路；样本查看页只渲染问句、最终回答和标准答案。就绪日期随远端数据变化，请在运行前查询 `GET /dates`，并逐模型核对 `GET /dashboard-data` 的 `ready` 和 `row_count`；本页不保存过期的日期清单。
