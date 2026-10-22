# 数据服务接口与说明

[返回工作台首页](../README.md)

服务只监听 `127.0.0.1:8081`，由工作台网关统一提供 `/data/*` 页面与 API。当前数据根为 `/mnt/fin_bench/eval_data`，外部状态根由 `workbench.json` 指定。

## 来源

| 来源 | 页面 | API 前缀 |
|---|---|---|
| wencai | `/data/wencai/` | `/data/wencai` |
| aime | `/data/aime/` | `/data/aime` |
| ifind | `/data/ifind/` | `/data/ifind` |

所有来源使用同一进程和端口，但原始包目录、输出目录、状态目录、去重范围和进度文件彼此独立。

## 页面

访问 `/data/` 进入数据区域首页。页面顶部只提供工作台、运行时和三个数据来源；日期表每页 14 天，显示最近收包、最近入库、待处理包、异常包和归档巡检结果。

wencai 每次展示 Fast 与 Expert 两个 A/B 对战和真实 Comparison 进度。aime/ifind 每次展示 Fast 与 Expert 的实际输入条数，以及标准制定、归因、聚类三个阶段的任务进度；不使用输入行数充当任务分母。

样本页按日期和模型打开，分列展示格式、Trace ID、问句和回答。Session 保留全部轮次；回答与标准答案默认折叠，展开后按安全 Markdown/GFM 渲染。所有来源位于同一数据区域，不使用独立端口的跳转链接。

## 接口

每个前缀都提供：

- `GET /health`
- `GET /dashboard-data`
- `GET /dates`
- `GET /data/{YYYY-MM-DD}/{model}.jsonl`
- `GET /records?date=YYYY-MM-DD&model=<model>`
- `GET /records/{YYYY-MM-DD}/{model}?page=1&page_size=20`
- `GET /processing-status`
- `POST /evaluation-progress`

示例：

```bash
curl -f http://127.0.0.1:8081/data/wencai/dashboard-data
curl -f http://127.0.0.1:8081/data/wencai/data/2026-10-21/a_fast.jsonl
curl -f http://127.0.0.1:8081/data/aime/health
```

`dashboard-data` 只把来源要求的全部模型均已 ready 的日期标记为整体 ready。下载响应必须带非负 `Content-Length`；客户端校验 JSONL 和行数后才提升输入快照。

## 进度

wencai 的 `/evaluation-progress` 只接收 `fast` 和 `expert` 两组计数，每组字段为：

```text
total_cases, completed_cases, running_cases, queued_cases, failed_cases, skipped_cases
```

aime/ifind 的进度按 `dates[].models.<model>.<stage>` 接收 `total / completed / running / pending / failed / blocked / cancelled`。同一来源内按日期和实际任务去重，不同来源互不覆盖。

自动化直接向 `http://127.0.0.1:8081/data/wencai/evaluation-progress` 上报，不经过本地脚本或公网端口。

## 状态与恢复

所有 ready、SQLite、记录偏移、进度、归档维护和临时解压目录位于 checkout 外的状态根。成功发布的数据不回撤，已有正式 JSONL 不删除，包删除或变坏不会回滚已接受输入。服务重启先恢复登记中的发布，再继续检查新包。
