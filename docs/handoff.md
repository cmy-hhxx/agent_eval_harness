# 远程输入服务接口

[返回首页](../README.md) · [自动化](automations.md) · [部署](deployment.md) · [输入契约](contract.md#输入)

数据服务只监听 `127.0.0.1:8081`。工作台通过 `/data/*` 访问它，自动化直接使用同机地址。当前来源和地址由外部 `runtime/config/automations.json` 与仓库 `configs/automations.manifest.json` 决定。

## 路由

| 来源 | 页面与 API 前缀 | 自动化 `sourceUrl` |
|---|---|---|
| 日常四路（wencai） | `/data/wencai/` | `http://127.0.0.1:8081/data/wencai` |
| aime | `/data/aime/` | 当前未登记自动化 |
| ifind | `/data/ifind/` | 当前未登记自动化 |

每个来源提供：

| 请求 | 用途 |
|---|---|
| `GET /health` | 服务健康 |
| `GET /dashboard-data` | 已就绪日期、模型行数和评测进度 |
| `GET /dates` | 可用日期与已发布模型 |
| `GET /data/{date}/{model}.jsonl` | 流式下载已就绪输入 |
| `GET /records?date=...&model=...` | 样本浏览页 |
| `GET /records/{date}/{model}?page=1&page_size=20` | 分页样本 API |
| `GET /processing-status` | 收包、待处理和异常状态 |
| `POST /evaluation-progress` | 自动化直接上报同机进度 |

完整 URL 为前缀加路径，例如 `http://127.0.0.1:8081/data/wencai/dashboard-data`。服务根路径和其他一级路径返回 404。

## 日期目录

`/dashboard-data` 返回 `dates` 数组。每个日期包含 `date`、`ready` 和 `models`；只有日期及该来源要求的全部模型均为 ready 时才能进入下载候选。`row_count` 必须是非负安全整数，日期不得重复。

```json
{
  "dates": [{
    "date": "2026-10-21",
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

日期筛选、轮询和复查周期来自自动化配置，不用文档中的示例数量推断。

## 输入下载

响应必须包含正文和非负整数 `Content-Length`。自动化核对实际字节数、JSONL 结构和实际行数，并要求行数不少于下载前目录观察值。目录在下载期间继续增长不使完整文件失效。

连接中断、无进展超时及 HTTP 408 / 429 / 5xx 在当前文件内最多尝试三次，间隔 1、2 秒。认证、JSONL、行数等非暂态错误直接交回整日调度，保留已有正式输入。JSONL 每行必须满足[输入契约](contract.md#输入)；记录身份为 `batch_id + case_id + version`。

## 进度上报

日常四路使用 `fast` 和 `expert` 两个固定模型对。每组六个计数均为非负整数，零值也保留：

```json
{
  "run_id": "daily-2026-10-21-a_fast__vs__b_fast",
  "engine": "pi",
  "status": "running",
  "started_at": 1792515600000,
  "updated_at": 1792519200000,
  "dates": [{
    "date": "2026-10-21",
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
        "total_cases": 100,
        "completed_cases": 8,
        "running_cases": 2,
        "queued_cases": 89,
        "failed_cases": 1,
        "skipped_cases": 0
      }
    }
  }]
}
```

`status` 为 `running / finished / interrupted`。aime 和 ifind 使用 `dates[].models.<model>.<criteria|attribution|clustering>` 的任务计数，不生成对战额度或配对结果。

自动化只在 `publishProgress: true` 时上报。上报错误写入自动化状态与现有日志，不阻断评测、MongoDB 交付或统计快照生成。
