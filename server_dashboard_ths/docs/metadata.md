# 标签与效率清洗

[数据服务](../README.md) · [实现](../metadata.py)

以下规整作用于各来源输出记录的 `meta`，不修改原包、消息或会话内的 trace。其他业务字段保留；`info` 保留为来源信息，统计使用 `meta` 的规范字段，不重复统计。

## 分类与 RUED

`task`、`subtask`、`agent_mode`、`testset_name`、`difficulty`、`difficulty_reason` 去首尾空格；缺失值从 `meta.info` 同名字段补齐。`rued` 和 `rued_reason` 同样从 info 补齐。直接值与 info 冲突时保留直接值并报告，不补造未知标签。

RUED 的 R、U、E、D 必须是整数（不接受布尔、浮点数或数字字符串），R∈[0,8]、U∈[0,3]、E∈[0,7]、D≥1：

```text
eta = 0.9783441714100146R + 1.5687846715589533U
    + 0.705878816282252E + 1.4419084167224514(D−1)
score = 50 × [1/(1+exp(1.3944910557482442−eta))
            + 1/(1+exp(5.496550951538168−eta))]
```

分数 ≤ 26.261252253428474 为简单，≤ 73.73874774657152 为中等，否则复杂。保存完整精度 `meta.difficulty_score`，不先四舍五入分档；R=0、U=0、E=1、D=1 的分数展示约为 17.1。

没有既有难度时补 `meta.difficulty`；既有明确难度（包括另行认定的长程）保留。参数非法则分数为 null；计算分档与既有标签冲突时报告，不覆盖标签。没有 RUED 不反推分数，也不自动判定长程。

## 时间与效率

| 内容 | 清洗后口径 |
|---|---|
| 请求时间 | 优先顶层或 meta 的 `request_time`；无时区按北京时间理解。缺失时使用 `timestamp_time`（epoch 毫秒，输出保留毫秒），再使用可用的 trace timestamp。`ask_time` 仅保留为抓取锚点，绝不补作请求时间；没有真实请求时间的记录排除 |
| 耗时 | 仅 `first_token_time_cost`、`first_answer_time_cost`、`finish_answer_time_cost`，单位毫秒。删除冗余 `cost`、`first_cost`、`first_answer_cost`，不从这些字符串或 trace latency 推算 |
| Token | 统一为 `usage.input_tokens`、`output_tokens`、`total_tokens`、`input_tokens_details.cached_tokens`。输入/输出缺项可由 meta 扁平字段补齐；usage 直接值优先，冲突报告。移除扁平 Token 字段和 `usage.cached_read_tokens`；usage 其他内容保留 |
| 总量 | 字段未提供且输入/输出均已知时求和；显式 null 保持未知；已报总量与两者之和不一致则记 null 并报告 |
| 缓存 | 优先取 input_tokens_details，其次 usage.cached_read_tokens、meta.cached_read_tokens；AA 未知缓存保持 null，不补 0。缓存超过输入量则记 null 并报告 |
| 指标校验 | 耗时、Token、answer_len、visual_count 接受非负安全整数；非法值记 null，真实 0 保留。has_visual 必须为布尔值 |

可选指标异常不排除有效回答。没有效率信息则保持缺失，不从答案长度估算 Token，不汇总 trace 快照作为总量。

## 报告与范围

报告的 `metadata_issue_count` 单独计异常项数（同一回答可有多项），`metadata_issues` 提供模型、case_id、原包/成员文件/行号/项号、field、reason、error。工作台“标签与效率异常”分页展示明细，摘要不复制全部异常。排除计数仅统计被排除的记录。

此改动不修改统计上传日志 Schema，不重写已经发布的历史输入；对之后执行清洗的新输入生效。
