# Prime Eval

通过本机 `prime-agent` 对已有回答做两阶段评测，输出与 `demo_output.jsonl` 一致的 schema 3.1。

[实施计划](docs/implementation-plan.md) · [初版 5 条样本验收](docs/acceptance.md)

1. **有标准答案的客观题**：`gpt-5.4-mini` 只看问题、标准答案、最终回复，独立判对错。
2. **两两比较**：`gpt-5.6-luna` 比较已有回答，可查阅本题完整链路和使用本地计算。

无标准答案按主观题处理，跳过第一阶段，业务记录保留 `is_correct=null`、`correctness_reason=""`，不在评语中解释评测流程。跳过状态仅记录在运行元数据。缺失版本只影响涉及它的配对，不算输或答错。比较重点是最后一轮，历史作为证据。

## 环境与快速运行

依赖由 **uv** 管理，Python 3.12，依赖锁定在 `uv.lock`。本地需安装 prime-agent；Node 仅用于独立运行扩展测试，prime-agent 自身负责加载扩展。

```bash
uv sync --locked
uv run prime-eval prepare --update-prime
uv run prime-eval preflight
```

`prepare` 检查官方最新稳定版，必要时更新。检查有效期为 24 小时；运行记录固定二进制、版本与 SHA256。同一个 run 恢复时不得换 prime-agent 版本。

API key 只从 `PRIME_EVAL_API_KEY` 环境变量读取，不写进命令参数、模型配置或日志。在 zsh 中可以隐藏输入：

```bash
read -rs 'PRIME_EVAL_API_KEY?请输入 API Key：'
export PRIME_EVAL_API_KEY
uv run prime-eval run --run-id batch-001
uv run prime-eval validate --run eval_output/batch-001
```

也可复制 `.env.example` 为本地 `.env`，填入自己的 key，然后执行 `uv run --env-file .env prime-eval run --run-id batch-001`。`.env` 已被 Git 忽略。

若要先用原来的两题联调：

```bash
uv run prime-eval run --batch 0b291c6224d24a9e --run-id debug-001
```

## 分阶段、恢复与增量

同一个 run 必须保持相同输入筛选、配置和程序版本。

```bash
# 阶段一：只有客观题会调用 Mini
uv run prime-eval run --run-id batch-002 --stage correctness

# 阶段二：读取阶段一结果，主观题直接比较
uv run prime-eval run --run-id batch-002 --stage pairwise --resume

# 中断后恢复，已完成任务不再调用模型
uv run prime-eval run --run-id batch-002 --resume

# 重新尝试失败或被阻塞的任务
uv run prime-eval run --run-id batch-002 --resume --retry-failed
```

如果新增了输入、换了模型、改了提示词或程序，请使用新的 `--run-id`。内容未变且原始审计文件仍存在的任务自动复用 `.eval-cache/` 中的缓存。两阶段的模型与提示词分别进入缓存键；只改变比较模型不会使 Mini 结果失效。配对缓存还包含独立正确性结果，防止错误复用旧判断。

`--batch` 和 `--case` 可重复使用；`--limit-cases` 按批次、case 排序取前 N 题。`preflight` 支持相同筛选选项，不产生模型费用。

## 输出

每次运行位于 `eval_output/<run-id>/`：

| 位置 | 内容 |
|---|---|
| `results/*__vs__*.jsonl` | 正式评测记录；最多六份，只有有效结果的组合才生成文件 |
| `correctness.jsonl` | 每个 case×版本唯一的正确性记录；主观题明确标记未评 |
| `skipped.jsonl` | 输入缺失或冲突导致的跳过 |
| `failures.jsonl` | 模型调用失败或前置任务阻塞 |
| `not_comparable.jsonl` | 材料不足以比较的记录及原因，不算平局 |
| `preflight.json` | 输入数量、预计任务数和输入异常 |
| `summary.json`、`report.md` | 覆盖、胜负、正确性、耗时与用量统计 |
| `manifest.json`、`schema.json` | 模型、配置、提示词、版本、输入指纹及任务映射 |
| `inputs/` | 输入快照，每份回答只保存一次，不在配对结果中复制全链路 |
| `tasks/<task-id>/attempt-*/` | 原始事件流、实际提示词、RPC 任务、用量、错误和请求约束记录 |
| `tasks/<task-id>/result.json` | 结构化提交、展开后的证据、来源路径与缓存来源 |

六个结果文件分别是 `a_fast__vs__a_expert`、`a_fast__vs__aa_fast`、`a_fast__vs__aa_expert`、`a_expert__vs__aa_fast`、`a_expert__vs__aa_expert`、`aa_fast__vs__aa_expert`。

文件名表示无序版本对。**行内 `models.A/B` 才是该次候选位置的真实映射**，不能假定文件名左边永远是候选 A。候选顺序由固定种子确定，以减少固定位置偏差。`models.*.llm` 是被评回答模型，不是裁判模型。

`message_index` 是各自原始 `messages` 数组从 0 开始的索引。嵌套原文路径保存在审计记录。`comparison_id` 由批次、case、版本对稳定生成。

各组可能使用不同题集，报告提供实际 case 列表及分母。正确率只统计有标准答案的唯一 case×版本；主观题跳过和客观题未判定分别列出，`null` 不算错误。

## 为什么输出不依赖“请返回 JSON”

- 模型通过 `submit_evaluation` 工具提交，而非自由文本输出。
- 请求钩子为提交工具设置 `strict: true`，使用原生 schema 约束；`tool_choice=required`，关闭并行工具调用以保持严格约束。
- 模型只选预先存在的引用 `ref`，每个候选的可选编号写入该次请求 schema 的枚举，避免编造编号或引用对手。
- 最终回答引用预先生成；检索历史材料会注册新编号。程序将编号恢复为原始 `message_index`、`quote`，再次核验原文。
- 批次、case、真实版本、trace ID、模型名、独立正确性结论由程序关联，模型不重写。
- 有效提交以 `terminate: true` 结束，省去额外的模型回复。无效提交返回具体问题，最多修复一次；失败不进入业务 JSONL。
- 原始工具参数和展开结果都保存，转换过程可追溯。网关不支持严格模式时明确失败，不静默退回自由文本解析。

仅开放本题的读取、检索、内嵌图片与数值运算工具，无任意 shell、任意文件路径、网络搜索或下载工具。第一阶段只开放计算与提交工具。

## 配置与提示词

默认配置：`configs/eval.toml`。支持多个输入批次；版本顺序和完整名称由 `inputs.versions` 声明。旧格式没有顶层 `batch_id` 时需配置 `inputs.default_batch_id`，不按行号或任意文件名猜测批次。

| 配置 | 默认 |
|---|---|
| `judge.correctness` | gpt-5.4-mini，low，4096 输出 token |
| `judge.pairwise` | gpt-5.6-luna，low，8192 输出 token |
| `execution.concurrency` | 8 |
| `execution.timeout_seconds` | 300 |
| `execution.idle_timeout_seconds` | 流式静默 45 秒后重试 |
| `execution.retries` | 临时错误额外重试 2 次 |
| `execution.repair_attempts` | 结构修复 1 次 |
| `execution.max_tool_calls` | 本地工具最多 8 次 |
| `execution.initial_context_chars` | 每个比较候选首轮材料最多 120000 字符 |

最终回答不截断；若超过首轮材料上限，任务明确报错。其他链路保留在输入快照，可分页读取；关闭自动上下文压缩。原始远程图片链接不下载，仅支持实际内嵌图片。

显式比例、倍数等计算题会要求双方各自完成本地核算后才开放提交工具。计算记录随评测保存，避免只检查一方、把另一方的小数位更多误当作更准确。

提示词位于 `prompts/`，schema 位于 `schemas/evaluation.json`，业务逻辑位于 `prime_eval/`，prime-agent 扩展位于 `extensions/evaluation-tools.js`。

## 验证与开发

```bash
uv run pytest -q
uv run pyright
node --test tests/tools.test.mjs
uv run prime-eval validate --run eval_output/batch-001
uv run prime-eval report --run eval_output/batch-001
```

CLI 退出码：0 为完成或有效；2 为配置、校验、输入异常或任务失败；130 为用户中断。`--stage correctness` 中尚未执行的比较任务不算失败。

如果在 macOS 受限沙箱中旧版 uv 的网络初始化触发 `system-configuration` panic，可在已执行 `uv sync` 后使用 `uv run --offline --no-sync ...`；这只限制 uv 的依赖操作，不限制评测程序访问模型网关。
