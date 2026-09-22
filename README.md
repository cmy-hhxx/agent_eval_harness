# Prime Eval

Prime Eval 使用本机 `prime-agent` 对已有回答做可追溯的两阶段评测：先独立核验有标准答案的回答，再对有效版本对做两两比较。评测结果使用稳定版本 ID，展示层可使用配置中的 `display_name`。

相关说明：[输入与输出契约](版本对比处理说明.md) · [输入数据说明](eval_input整理说明.md)

## 运行环境

- Python 3.12，依赖由 `uv` 和 `uv.lock` 管理。
- 本机需要安装 `prime-agent`。
- `PRIME_EVAL_API_KEY` 只从环境变量读取。
- Node.js 仅用于运行扩展测试。

首次运行先同步依赖并核对 Prime Agent 稳定版：

```bash
uv sync --locked
uv run prime-eval prepare --update-prime
uv run prime-eval preflight
```

`prepare` 会记录二进制路径、版本和 SHA256。评测要求检查记录不超过 24 小时，恢复同一 run 时不能更换 Prime Agent。

## 快速运行

配置文件是 `configs/eval.toml`。不指定 `--run-id` 时，CLI 使用当前时间生成 run ID；固定 ID 便于恢复：

```bash
uv run prime-eval run --run-id batch-001
uv run prime-eval validate --run eval_output/batch-001
uv run prime-eval report --run eval_output/batch-001
```

筛选批次或 case 可重复传入参数；`--limit-cases N` 按批次和 case 排序取前 N 个 case。先用 `preflight` 检查输入、缺失版本、冲突和预计任务数，不产生模型调用：

```bash
uv run prime-eval preflight --batch <batch-id> --case <case-id>
```

## 评测流程

1. **正确性阶段**：有标准答案时，`gpt-5.6-luna` 只接收问题、标准答案和最终回答，输出 `is_correct`、理由和证据。无标准答案的输入跳过此阶段，输出中保留 `is_correct=null`。
2. **两两比较阶段**：`gpt-5.6-luna` 比较两个版本的最终回答和可按需读取的完整链路，输出胜负、具体优缺点、任务分析、得分点、red flags 和可比较时的原始回答耗时。

每份比较草稿由独立上下文的 `gpt-5.6-luna` 做轻量质检，预算15秒。只对明确影响胜负的算术、比较方向、证据或新增硬要求问题触发一次修订，修订预算30秒；次要点评和文风只留建议。修订后不循环复核；质检超时或修订失败仍保留已完成的原评测，状态写入 `quality_reviews.jsonl`，不中断交付。两个预算不包括本地进程回收时间。质检使用严格工具 schema，意见只能选择有效字段，原文由程序恢复。

质检状态：`passed` 未检出问题；`advisory` 只有建议；`revised` 已修订、未再次复核；`unavailable` 质检未完成；`unresolved` 已发现硬伤但未修复。最后两类保留原评测供查看，不应当成已确认的正式排名依据。任务收据绑定评测文本哈希，防止恢复时混入事后改写。`tasks/<task-id>/attempt-*/` 保留原稿、质检意见和自动修订；不人工改写成功结果。

结论先行，使用实际版本名称；平局在理由中明确“两个都好”或“两个都差”，JSONL 的 `result` 仍保持 `win/tie`。采纳《自动评测高质量表述要点》的事实、位置、依据与影响要求；不强制凑三段或填空项，不把示例中的事实、投资偏好和附加字段变成通用扣分项。得分点和红线描述同类任务，具体公司、日期和数值放在本题分析中。

同一 case 的问题或标准答案冲突时不生成配对；缺少某个版本只跳过涉及它的配对。候选 A/B 由固定种子随机分配，结果始终关联回真实版本 ID。

一次 `run` 默认并行调度两个阶段；有标准答案的配对只等待自身的正确性任务。每个 run 使用独立 daemon socket，成功提交后立即保存 `tasks/<task-id>/result.json`，并按配置复用内容缓存。模型调用失败不会写入正式比较结果。

中断后从任务边界恢复，不续接未完成的流式输出：

```bash
uv run prime-eval run --run-id batch-001 --resume
uv run prime-eval run --run-id batch-001 --resume --retry-failed
uv run prime-eval run --run-id batch-001 --stage correctness
uv run prime-eval run --run-id batch-001 --stage pairwise --resume
uv run prime-eval status --run eval_output/batch-001
```

输入、模型、提示词、schema 或程序变更后必须使用新的 run ID。`report` 可从已保存的任务收据重建汇总，不调用模型；传入 `--config` 只更新输出 schema 和显示名称。

## 输出目录

每次运行写入 `eval_output/<run-id>/`：

| 文件或目录 | 内容 |
| --- | --- |
| `results/<version>__vs__<version>.jsonl` | 按版本对分组的有效比较结果，最多六组 |
| `task_summaries.jsonl`、`task_summaries.md` | 逐题问题、结论、双方优劣势、耗时、得分点和 red flags |
| `correctness.jsonl` | 每个 case×版本的独立正确性或主观题跳过记录 |
| `task_outcomes.jsonl` | 每个任务的状态、缓存来源和耗时 |
| `skipped.jsonl`、`failures.jsonl`、`not_comparable.jsonl` | 输入缺失/冲突、任务失败和材料不足的记录 |
| `preflight.json`、`progress.json`、`summary.json`、`report.md`、`validation.json` | 计划、实时进度、汇总统计、可读报告和校验结果 |
| `manifest.json`、`schema.json`、`output_schema.json`、`version_names.json` | 本次运行的配置、schema 和版本显示名快照 |
| `inputs/` | 每份输入的一次快照 |
| `tasks/<task-id>/` | prompt、RPC 事件、工具提交、用量、错误和最终任务收据 |

比较输出使用 schema 3.2。`models`、`evaluations` 和总结中的候选以版本 ID 为键；`models.<id>.version` 是显示名称。`verdict.result` 为 `win` 或 `tie`，赢家由 `winner_version` 和 `winner_name` 明确给出。材料不足时记入 `not_comparable`，不作为平局。

每条证据由原始 `message_index` 和逐字 `quote` 组成。严格的 `submit_evaluation` 工具只允许选择程序预先注册的引用；程序在本地展开引用并再次校验原文。涉及比例、倍数、差额或换算时，双方必须分别使用本地 `calculate` 工具完成核算后才能提交。

## 配置与代码位置

| 路径 | 用途 |
| --- | --- |
| `configs/eval.toml` | 输入版本、裁判模型、并发、超时、缓存和产物路径 |
| `prompts/` | system、correctness、pairwise、repair 提示词 |
| `schemas/evaluation.json` | 评测提交和导出的 JSON Schema 3.2 |
| `prime_eval/` | 输入适配、任务规划、Prime 调用、恢复、汇总和校验 |
| `extensions/evaluation-tools.js` | 受限读取、检索、图片、计算和严格提交工具 |

默认配置：

| 配置项 | 默认值 |
| --- | --- |
| `judge.correctness` | `gpt-5.6-luna`，`low`，4096 输出 token |
| `judge.pairwise` | `gpt-5.6-luna`，`low`，8192 输出 token |
| `judge.audit` | `gpt-5.6-luna`，`low`，4096 输出 token |
| `execution.concurrency` | 8 |
| `execution.timeout_seconds` | 300 |
| `execution.idle_timeout_seconds` | 45 |
| `execution.retries` | 默认不自动重试，失败任务可用 --retry-failed 重跑 |
| `execution.repair_attempts` | 1 次结构修复 |
| `execution.audit_timeout_seconds` | 15 秒 |
| `execution.quality_repair_timeout_seconds` | 30 秒 |
| `execution.quality_repair_attempts` | 最多1次修订，不循环复核 |
| `execution.max_tool_calls` | 8 |
| `execution.initial_context_chars` | 16000 |
| `execution.report_interval_seconds` | 30 |

## 验证

```bash
uv run pytest -q
uv run pyright
node --test tests/tools.test.mjs
uv run prime-eval validate --run eval_output/<run-id>
```

CLI 退出码：`0` 表示完成或校验有效，`2` 表示配置、输入、校验或任务失败，`130` 表示用户中断。
