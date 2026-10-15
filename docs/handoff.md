# 远程输入服务接口

[返回首页](../README.md) · [自动化运行与交付](automations.md) · [输入记录契约](contract.md#输入)

本页只维护本仓库实际消费的 HTTP 接口。服务地址由 [automations.json](../configs/automations.json) 的 `sourceUrl` 配置；客户端实现见 [RemoteInputs](../packages/runtime/src/remote-inputs.ts)。远端部署、压缩包处理和数据盘点由服务方维护，参见[远端文档](http://117.50.195.94:2256/docs)；可用日期以运行时目录为准。

## 接口

| 请求 | 本地用途 |
|---|---|
| `GET /dashboard-data` | 发现已就绪日期及四模型行数 |
| `GET /data/{date}/{model}.jsonl` | 流式下载模型输入 |
| `POST /evaluation-progress` | 上报已登记运行的 Comparison 进度 |

模型 ID 固定为 `a_fast`、`b_fast`、`a_expert`、`b_expert`；日期为有效的 `YYYY-MM-DD`。本地未配置远端鉴权。目录读取和进度上报最多等待 10 秒；下载采用配置中的无数据进展超时。

## 日期目录

`/dashboard-data` 返回带 `dates` 数组的 JSON。每个日期包含 `date`、`ready` 和 `models`；只有日期及四个模型均为 ready 才进入下载候选。四模型的 `row_count` 必须是非负安全整数，日期不得重复。

```json
{
  "dates": [{
    "date": "2026-09-29",
    "ready": true,
    "models": {
      "a_fast": { "ready": true, "row_count": 100 },
      "b_fast": { "ready": true, "row_count": 100 },
      "a_expert": { "ready": true, "row_count": 100 },
      "b_expert": { "ready": true, "row_count": 100 }
    }
  }]
}
```

日期筛选、轮询和定期复查取自自动化配置，不根据文档中的历史数量或日期范围推断可用性。

## 输入下载

响应必须包含正文及非负整数 `Content-Length`。本地核对实际字节数、JSONL 结构和目录行数，下载结束再核对目录，完整日期校验通过后才替换本地源文件。响应 `404` 且 JSON `error` 为 `data not ready` 时按远端准备中处理；其他 HTTP 错误保留状态码和可解析原因。

接口不提供可供本地使用的修订号或不可变快照 ID。行数相同不代表内容相同，也不能保证四文件来自同一生成时刻；同量内容修正通过定期逐块比较发现。已有正式结果仍遵守[同 run 续跑规则](usage.md#运行与恢复)。源文件提升和失败恢复见[自动化状态](automations.md#调度与状态)。

JSONL 每行必须满足[输入契约](contract.md#输入)。远端日期用于文件组织和下载选择，记录身份仍是 `batch_id + case_id + version`；本地不根据请求时间重新分批。

## 进度上报

POST 使用 `application/json`，时间戳为 Unix 毫秒。`dates` 按输入来源日期分组，`pairs` 固定且仅包含 `fast` 与 `expert`，分别对应 A/B Fast 与 A/B Expert；不可直接发送内部模型组合键或额外 baseline 配对。刚发现、尚无 Host 检查点的日期也提供这两组零计数。每组包含以下六个非负整数，零值也保留：

```json
{
  "run_id": "daily-2026-09-29",
  "engine": "pi",
  "status": "running",
  "started_at": 1790683200000,
  "updated_at": 1790683200000,
  "dates": [{
    "date": "2026-09-29",
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
  }]
}
```

`status` 为 `running / finished / interrupted`。样本在日期和配对内按 `batch_id + case_id` 去重；`total_cases - skipped_cases` 为可评测数量。只统计 Comparison：失败和超时计失败，取消和依赖阻塞计排队，预检无法配对计跳过；Rewrite 与 Clustering 不进入该分母。跨 run 去重时按运行中、失败、成功、跳过、排队的优先级归类。

自动化从 Host 检查点生成进度，`publishProgress` 控制是否发送。远端拒绝旧上报者时返回的 HTTP 409 会保留为 `reportError`；上报失败不阻断评测。远端看板在未达每档 300 次额度时，会将当前目录行数与上报范围核对，新增输入或仍有缺配对时不显示完成；达额度后的 ✅ 仅表示当日额度已完成。目录行数不能用于推算精确配对或排队数。远端 Comparison 完成数不表示改写已完成，本地完整交付以[自动化完成条件](automations.md)为准。
