# Prime Eval

通过本机 `prime-agent` 对已有回答做两阶段评测。沿用 demo 的问题、结论、优劣势与证据结构；当前 schema 3.2 将候选位置替换为实际版本标识和名称。

[实施计划](docs/implementation-plan.md) · [4条真实评测交付](docs/acceptance.md) · [速度与续跑验收](docs/iteration-3.md) · [旧产物清理](docs/cleanup.md)

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

每次运行使用独立 daemon socket，任务结束或中断时使用本机 `lsof` 定位并关闭持有该 socket 的进程，避免共享后台进程的会话阻塞。macOS 自带 `lsof`；不会调用停止全部 Prime 服务的全局 shutdown。

API key 只从 `PRIME_EVAL_API_KEY` 环境变量读取，不写进命令参数、模型配置或日志。在 zsh 中可以隐藏输入：

```bash
read -rs 'PRIME_EVAL_API_KEY?请输入 API Key：'
export PRIME_EVAL_API_KEY
uv run prime-eval run --run-id batch-001
uv run prime-eval validate --run eval_output/batch-001
```

也可复制 `.env.example` 为本地 `.env`，填入自己的 key，然后执行 `uv run --env-file .env prime-eval run --run-id batch-001`。`.env` 已被 Git 忽略。

先跑固定的 5 条比较，覆盖宏观查询、财务计算、市场异动分析及耗时缺失：

```bash
uv run prime-eval run --run-id smoke-5-v3 \
  --case 1_数据查询_6292句_20260911_1955 \
  --case 14_多轮选股_258题_20260911_Q023_2_T08_multi \
  --case 市场热点与异动归因_20题_20260921_Q003 \
  --case 市场热点与异动归因_20题_20260921_Q004 \
  --case 市场热点与异动归因_20题_20260921_Q007
uv run prime-eval validate --run eval_output/smoke-5-v3
```

这五个 case 在当前输入中各有一个有效版本对，因此恰好生成 5 条比较；有标准答案的其中一题另需 2 次 Mini 判定。若此 run 已存在，保持代码/配置不变时加 `--resume`，否则换一个 run-id。`--limit-cases 5` 只限制题数，不保证只有五组配对。

## 分阶段、恢复与增量

正式评测时固定 run-id、输入筛选、模型、提示词和程序版本。已成功任务经过 schema 和原文证据校验后直接跳过；未完成的任务继续执行；失败任务只有加 `--retry-failed` 才重试。输入变化会拒绝混入同一个 run。

```bash
# 阶段一：只有客观题会调用 Mini
uv run prime-eval run --run-id batch-002 --stage correctness

# 阶段二：读取阶段一结果，主观题直接比较
uv run prime-eval run --run-id batch-002 --stage pairwise --resume

# 中断后恢复，已完成任务不再调用模型
uv run prime-eval run --run-id batch-002 --resume

# 重新尝试失败或被阻塞的任务
uv run prime-eval run --run-id batch-002 --resume --retry-failed

# 查看当前完成数、失败数、缓存复用数和正在评测的对局
uv run prime-eval status --run eval_output/batch-002
```

每条有效提交立即原子保存到 `tasks/<task-id>/result.json`，先保存任务收据，再保存复用缓存。`progress.json` 在任务开始、重试、完成和中断时更新。整批 JSONL/Markdown 在任务完成时按30秒间隔刷新，退出时完整导出；崩溃后可用 `report` 从任务收据重建，不能将最后一次汇总当作唯一断点。续跑以对局为单位，不尝试续接一段未完成的模型流式输出。

默认一次运行会并行启动独立正确性核验和无需核验的主观题比较；有标准答案的对局只等待自己的前置结果，不等待整个第一阶段结束。并发上限由 `execution.concurrency` 统一控制。

如果新增了输入、换了模型、改了提示词或程序，请使用新的 `--run-id`。内容未变且原始审计文件仍存在的任务自动复用 `.eval-cache/` 中的缓存。两阶段的模型与提示词分别进入缓存键；只改变比较模型不会使 Mini 结果失效。配对缓存还包含独立正确性结果，防止错误复用旧判断。

`--batch` 和 `--case` 可重复使用；`--limit-cases` 按批次、case 排序取前 N 题。`preflight` 支持相同筛选选项，不产生模型费用。

## 输出

每次运行位于 `eval_output/<run-id>/`：

| 位置 | 内容 |
|---|---|
| `results/*__vs__*.jsonl` | 正式评测记录；最多六份，只有有效结果的组合才生成文件 |
| `task_summaries.jsonl`、`task_summaries.md` | 问题明细、结论、各版本优劣势、原始回答耗时、得分点和 red flags |
| `progress.json` | 实时任务状态、复用数量和正在执行的对局 |
| `correctness.jsonl` | 每个 case×版本唯一的正确性记录；主观题明确标记未评 |
| `skipped.jsonl` | 输入缺失或冲突导致的跳过 |
| `failures.jsonl` | 模型调用失败或前置任务阻塞 |
| `not_comparable.jsonl` | 材料不足以比较的记录及原因，不算平局 |
| `preflight.json` | 输入数量、预计任务数和输入异常 |
| `summary.json`、`report.md` | 覆盖、胜负、正确性、耗时与用量统计 |
| `manifest.json`、`schema.json` | 模型、配置、提示词、版本、输入指纹及任务映射 |
| `output_schema.json`、`version_names.json` | 输出结构与显示名称快照，可独立更新，不修改原始评测提交 |
| `inputs/` | 输入快照，每份回答只保存一次，不在配对结果中复制全链路 |
| `tasks/<task-id>/attempt-*/` | 原始事件流、实际提示词、RPC 任务、用量、错误和请求约束记录 |
| `tasks/<task-id>/result.json` | 结构化提交、展开后的证据、来源路径与缓存来源 |

六个结果文件分别是 `a_fast__vs__a_expert`、`a_fast__vs__aa_fast`、`a_fast__vs__aa_expert`、`a_expert__vs__aa_fast`、`a_expert__vs__aa_expert`、`aa_fast__vs__aa_expert`。

文件名表示无序版本对。`models`、`evaluations` 和总结中的 `candidates` 均以稳定版本 ID 为键，如 `a_fast`；`models.a_fast.version` 是显示名称，如 `A组Fast`。`verdict.result` 为 `win` 或 `tie`，`winner_version`、`winner_name` 明确指向实际赢家，平局时二者为 null。评语正文也使用实际名称，原文引文不改写。随机候选位置仅保留在内部盲评协议和审计材料中，不能按文件名左右顺序推断赢家。`models.*.llm` 是被评回答模型，不是裁判模型。

`message_index` 是各自原始 `messages` 数组从 0 开始的索引。嵌套原文路径保存在审计记录。`comparison_id` 由批次、case、版本对稳定生成。

各组可能使用不同题集，报告提供实际 case 列表及分母。正确率只统计有标准答案的唯一 case×版本；主观题跳过和客观题未判定分别列出，`null` 不算错误。

## 逐题总结

每次比较在同一个严格工具提交中给出 `task_analysis`，不新增总结模型调用。程序将它与既有 verdict、findings 和输入数据关联，生成下面的总结：

- **问题明细**：原始问句、具体题型、对象/日期/口径、核心交付要求。
- **测评结论**：决定胜负的具体差异，结合质量与等待成本分析。
- **各版本优劣势**：直接使用实际版本名称，每项写清实际表现、对应要求、影响和原文证据；不以“更完整/更严谨”代替具体分析。
- **原始回答耗时**：首 token、首回答、完成时间与来源字段，另附质量与耗时的取舍说明。
- **得分点与 red flags**：按此类任务列出简短、可检查的加分动作和不能犯的错误；实际是否触犯，以有证据的 findings 为准。

比较 JSONL 使用 schema 3.2，补充总结通过 `comparison_id` 关联。消费方需要将旧版候选字母索引切换为版本 ID，并读取显式赢家字段。结论和优劣势复用同一次提交，不新增模型调用。`validate` 同时检查 JSONL 总结、可读报告、耗时来源与原比较记录的一致性。

已有第二版4条结果已重新导出。只改显示名称时调整配置中的 `display_name`，然后运行以下命令，不会重新评测，也不改变原始结论：

```bash
uv run prime-eval report --run eval_output/smoke-5-v2 --config configs/eval.toml
uv run prime-eval validate --run eval_output/smoke-5-v2
```

耗时读取 `meta.first_token_time_cost`、`meta.first_answer_time_cost`、`meta.finish_answer_time_cost`。`inputs.timing_unit="ms"` 声明当前采集口径，统一换算为秒；不同版本可在其 `inputs.versions` 中覆盖为 `s`。缺失或无效数值保持 null，缺少任一方完成时间时不计算快慢差值。来源值及单位一并保留；裁判自身的评测耗时仅在审计记录中统计，不能代替被评回答的耗时。

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

默认配置：`configs/eval.toml`。支持多个输入批次；版本顺序、输入原始 `name` 与输出 `display_name` 由 `inputs.versions` 声明。`name` 必须匹配输入，`display_name` 可独立设置，省略时沿用 `name`。旧格式没有顶层 `batch_id` 时需配置 `inputs.default_batch_id`，不按行号或任意文件名猜测批次。

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
| `execution.initial_context_chars` | 每个比较候选首轮材料软预算 16000 字符 |
| `execution.report_interval_seconds` | 任务完成时整批报告刷新的最短间隔，默认30秒 |

完整问题与最终回答优先保留，超过软预算也不截断；其余预算优先放入近期对话，完整历史与工具链路可按需读取。最终回答以带引用编号的文本片段发送一次，省去重复的证据目录。关闭自动上下文压缩。原始远程图片链接不下载，仅支持实际内嵌图片。

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
