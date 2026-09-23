# Prime Eval

Prime Eval 使用本机 `prime-agent` 对已有回答做可追溯的两阶段评测：先独立核验有标准答案的回答，再比较同档位的 A组与 AA组。只允许 **A Fast ↔ AA Fast**、**A Expert ↔ AA Expert**，每个 case 最多两场。评测结果使用稳定版本 ID，展示层可使用配置中的 `display_name`。

相关说明：[输入与输出契约](版本对比处理说明.md) · [输入数据说明](eval_input整理说明.md) · [配对限制修改计划](评测配对限制修改计划.md)

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

主评测一次完成，不调用独立质检模型或自动返工。提示词只抓影响胜负的关键差异，允许忽略次要瑕疵；必要的判分边界在主评测内处理。程序保留严格 schema、逐字引用、胜负开头、双方算式及输出一致性校验。有标准答案的独立正确性阶段仍保留。计算题优先通过 `calculate_pair` 一次完成双方核算，减少一轮模型请求。

数值题由主评测结合题目和上下文识别统一基准，并在理由或 finding 中列明双方关键算式及结果；缺少独立标准答案不等于缺少计算基准。计算日志保留供核验，导出不根据最后一次工具计算追加口径判断。胜负理由必须写明谁好在哪里、另一方差在哪里及决定胜负的原因；提到胜出方缺点时，要解释为何不足以改变结论。

结论先行，使用实际版本名称；平局在理由中明确“两个都好”或“两个都差”，JSONL 的 `result` 仍保持 `win/tie`。采纳《自动评测高质量表述要点》的事实、位置、依据与影响要求；不强制凑三段或填空项，不把示例中的事实、投资偏好和附加字段变成通用扣分项。得分点和红线描述同类任务，具体公司、日期和数值放在本题分析中。

同一 case 的问题或标准答案冲突时不生成配对；缺少某个版本只跳过涉及它的允许配对。禁止同组跨档位、跨组跨档位及自身比较，不为这些组合创建任务或跳过记录。正确性任务也只为实际参与允许配对的回答创建。候选 A/B 由固定种子随机分配，它们是盲测标签，不代表 A组/AA组；结果始终关联回真实版本 ID。

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

旧运行若含禁止组合，`report` 会拒绝导出，`validate` 会报告错误。先按[清理计划](评测配对限制修改计划.md)删除相关任务、缓存和衍生输出并更新任务清单，再重建报告；只删除结果 JSONL 不能完成清理。

## 输出目录

每次运行写入 `eval_output/<run-id>/`：

| 文件或目录 | 内容 |
| --- | --- |
| `results/<version>__vs__<version>.jsonl` | 只含 `a_fast__vs__aa_fast.jsonl`、`a_expert__vs__aa_expert.jsonl`，最多两组 |
| `task_summaries.jsonl`、`task_summaries.md` | 逐题问题、结论、双方优劣势、耗时、得分点和 red flags |
| `correctness.jsonl` | 每个 case×版本的独立正确性或主观题跳过记录 |
| `task_outcomes.jsonl` | 每个任务的状态、缓存来源和耗时 |
| `skipped.jsonl`、`failures.jsonl`、`not_comparable.jsonl` | 输入缺失/冲突、任务失败和材料不足的记录 |
| `preflight.json`、`progress.json`、`summary.json`、`report.md`、`validation.json` | 计划、实时进度、汇总统计、可读报告和校验结果 |
| `manifest.json`、`schema.json`、`output_schema.json`、`version_names.json` | 本次运行的配置、schema 和版本显示名快照 |
| `inputs/` | 每份输入的一次快照 |
| `tasks/<task-id>/` | prompt、RPC 事件、工具提交、用量、错误和最终任务收据 |

比较输出使用 schema 3.3。`models`、`evaluations` 和总结中的候选以版本 ID 为键；`models.<id>.version` 是显示名称。`verdict.result` 为 `win` 或 `tie`，赢家由 `winner_version` 和 `winner_name` 明确给出。材料不足时记入 `not_comparable`，不作为平局。

每条证据由原始 `message_index` 和逐字 `quote` 组成。严格的 `submit_evaluation` 工具只允许选择程序预先注册的引用；程序在本地展开引用并再次校验原文。涉及比例、倍数、差额或换算时，双方必须分别使用本地 `calculate` 工具完成核算后才能提交。

工具定位只使用两个字段：`stage` 保留原评测阶段，`stage_trace` 集中保存工具、原始消息位置、置信度和来源。`run` 和 `report` 都从输入快照自动生成工具回溯，不要求裁判填写，不增加模型调用；逐题 Markdown 同时展示明确的工具来源。字段定义见[输入与输出契约](版本对比处理说明.md)。

## 配置与代码位置

| 路径 | 用途 |
| --- | --- |
| `configs/eval.toml` | 输入版本、裁判模型、并发、超时、缓存和产物路径 |
| `prompts/` | system、correctness、pairwise、repair 提示词 |
| `schemas/evaluation.json` | 评测提交和导出的 JSON Schema 3.3 |
| `prime_eval/` | 输入适配、任务规划、Prime 调用、恢复、汇总和校验 |
| `prime_eval/annotations.py` | 按 finding 引文与消息位置生成工具回溯 |
| `extensions/evaluation-tools.js` | 受限读取、检索、图片、计算和严格提交工具 |

默认配置：

| 配置项 | 默认值 |
| --- | --- |
| `judge.correctness` | `gpt-5.6-luna`，`low`，4096 输出 token |
| `judge.pairwise` | `gpt-5.6-luna`，`low`，8192 输出 token |
| `execution.concurrency` | 8 |
| `execution.timeout_seconds` | 300 |
| `execution.idle_timeout_seconds` | 45 |
| `execution.retries` | 默认不自动重试，失败任务可用 --retry-failed 重跑 |
| `execution.repair_attempts` | 1 次结构修复 |
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
