# 使用指南

[返回首页](../README.md) · 输入和结果语义见[数据契约](contract.md)。

## 环境与配置

工具版本由 [mise.toml](../mise.toml) 固定。安装步骤见首页。根 `.venv` 供公共 Python 代码工具使用；Prime 自身的 runtime 位于 `.runtime/prime-python`，两者独立。

根 `.env` 是两种底座共用的模型连接配置：

```dotenv
EVAL_BASE_URL=https://api.openai.com/v1
EVAL_API_KEY=your-key
```

将 URL 换成实际网关地址，保留网关要求的 `/v1` 路径。`npm run eval`、`npm run doctor` 和两个 Worker 的 workspace start 命令自动读取根 `.env`；已有环境变量优先。切换 `--engine pi|prime` 不需要更换变量名或复制密钥。`.env` 不入库，示例见 [.env.example](../.env.example)。

[configs/host.json](../configs/host.json) 配置输入、模型和执行预算：

| 配置 | 含义 |
|---|---|
| `inputs.versions` | 输入目录与版本 ID、展示名称、A / AA 适配器的对应关系；目录会递归读取各日期子目录下对应版本名的 JSONL |
| `inputs.timing_unit` | 原始耗时单位，`ms` 或 `s` |
| `judge.baseUrlEnv` / `judge.apiKeyEnv` | 共用 URL / key 的环境变量名 |
| `judge.api` | `openai-completions` 或 `openai-responses` |
| `judge.correctness` / `judge.pairwise` | 各阶段的模型、thinking、上下文和输出 token 上限 |
| `execution` | 并发、超时、工具预算、修正和重试 |
| `outputDir` | 运行产物 |

配置中的相对路径相对于配置文件目录解析。完整类型见 [EvalConfig](../packages/pairwise-eval/src/types.ts)，预算默认值见 [DEFAULT_POLICY](../packages/contracts/src/index.ts)。不在文档复制一套默认值。

## 目录约定

| 位置 | 内容 | 是否入库 |
|---|---|---|
| `data/inputs/` | 按日期子目录保存四个版本的原始 JSONL | 否 |
| `data/runs/<run-id>/` | 当前 Host 的全部运行产物 | 否 |
| `.cache/evaluations/` | 历史缓存目录，保留但不再读写 | 否 |
| `.cache/npm/`、`.cache/uv/` | 下载缓存 | 否 |
| `.runtime/`、`.venv/`、`dist/` | 可重建的执行环境和构建产物 | 否 |
| `.artifacts/` | 开发验证日志、临时计划和检查结果 | 否 |

新数据和结果都放进 `data/`，不要新增根目录输入、输出文件夹。

## 运行与恢复

```bash
npm run eval -- preflight
npm run eval -- run --engine pi --run-id pi-001
npm run eval -- run --engine prime --run-id prime-001
npm run eval -- run --engine pi --run-id pi-debug --debug
npm run eval -- status --run data/runs/pi-001
npm run eval -- validate --run data/runs/pi-001
npm run eval -- report --run data/runs/pi-001
npm run eval -- report --run data/runs/pi-debug --details
```

`preflight` 只检查输入，不调用模型；有输入问题返回退出码 2。没有有效配对时拒绝运行。`--config` 可指定配置；`--batch ID`、`--case ID` 可重复；`--limit-cases N` 按批次与 case 排序截取，不保证首题有有效配对。

输入的每日批次约定见[数据契约](contract.md#输入)。不指定 `--batch` 时处理全部输入批次，多个 `--batch` 取并集，并与 `--case` 条件取交集。同 case 出现在不同批次时分别计数，`--limit-cases` 限制整个选择结果的样本数。以下命令选择一个或两个日期批次；批次 ID 使用输入中的实际值：

```bash
npm run eval -- preflight --batch 2026-09-23
npm run eval -- run --engine pi --run-id daily-0923-0924 --batch 2026-09-23 --batch 2026-09-24
```

再次执行相同 `--run-id` 自动续跑。Host 从 v6 `state.json` 读取任务索引、源文件引用、预检诊断、收据、修复草稿和累计用量，A/B 分配不再重建。代码、模型和预算变化不阻止续跑；已接受的任务始终保留，其他 run 不复用结果。模型服务端缓存行为保持不变。

续跑扫描原运行已选批次，按 `batch_id + case_id + 阶段 + 版本组合` 识别任务。已经接受的正确性和配对结果不再评测，即使原输入、标准答案或模型参数发生变化。只为未完成任务读取最新有效输入，并加入新增配对；需要重新评测已完成样本时使用新 run ID。无效或冲突记录不能覆盖未完成任务；缺少其材料时明确报错。缩小本次 `--batch` 不删除原任务；新日期批次使用新 run ID。累计 attempts/Token 保留所有历史执行成本。运行退出码：0 成功、2 有失败、130 被中断。

内容修复、文件加载和传输错误使用独立预算。内容失败最多自动开启一次跨 attempt 续修，带入最后草稿和结构化反馈；连续两次出现相同字段、错误码及实际错误时停止。每次内容修复预留一次材料或代码工具调用；每 attempt 最多三次文件加载失败，路径/读取/JSON 解析错误不消耗内容修复次数。连接与流中断按 `execution.retries` 有界退避。

运行中可调整并发并查看进度：

```bash
npm run eval -- concurrency --run data/runs/pi-001 --value 8
npm run eval -- progress --run data/runs/pi-001
```

提高并发立即唤醒调度器并按需启动托管 Worker；降低并发停止补位，让健康任务自然完成。外部 Worker 只调整使用数量。默认并发保持配置值。进度包含排队、运行、接受、修复、失败分类、近期吞吐和最长无进展任务；至少五个耗时样本后才提供 ETA 区间。

v4 / v5 状态必须显式升级：

```bash
npm run eval -- upgrade-run --run data/runs/pi-001
npm run eval -- upgrade-run --run data/runs/pi-001 --apply
```

无 `--apply` 只预览。升级使用运行锁，逐条确认旧快照与原文件一致后，原子替换为精简状态，再删除已经确认重复的 run 输入文件；不再创建整份运行备份。中断后重跑同一命令完成剩余去重；源文件缺失或内容不同则保留旧材料并报错。保留 run/task/comparison/submission ID、A/B 分配、判决和累计用量，不调用模型，不改写正式 JSONL。常规运行仅读取 v6。

## 运行产物

所有交付文件位于 `data/runs/<run-id>/`，不生成 ZIP、tar 等压缩交付包。默认包含 `report.md`、`task_summaries.md`、`results/`、`state.json` 和 `stats.json`；运行中的 `.run-lock` 在退出时释放。

| 文件 | 用途 |
|---|---|
| `report.md` | 总览、分批样本与配对汇总、异常数量、用量缺失和校验状态 |
| `results/<pair>.jsonl` | 正式配对结果，每接受一条成功提交就追加一行并刷盘，运行中即可读取 |
| `results/not_comparable.jsonl` | 不可比较结果，同样逐条追加，有记录时才生成，不计入正式比较数量 |
| `task_summaries.md` | 以 `batch_id / case_id` 标识逐题结论、双方优缺点、耗时，以及失败、不可比较、输入跳过原因和输入异常 |
| `state.json` | 唯一进度账本：任务与输入索引、批次范围、预检、结果引用、待修草稿与错误、累计用量；候选信息仅登记一次 |
| `stats.json` | 仅保留数量、配对胜出、Token、缓存命中、耗时和校验汇总，不包含逐题 ID 或异常明细 |

`stats.json` 的 `by_batch` 按批次保存 `planned`、`task_statuses`、`completed_comparisons`、`pairs`，有独立正确性评测时包含 `per_version`，字段口径与总体统计一致。失败和待完成按任务计数，计划任务包含正确性和配对阶段；有效比较仅统计配对判决中的胜出、都好、都差。正式 JSONL 继续通过 `case.batch_id` 区分批次。Token、耗时和缓存统计保持全局口径。

`stats.json` 的 `tokens` 汇总所有已记录尝试，包含失败和重试；`input` 为未命中缓存的输入，`cacheRead` / `cacheWrite` 为缓存读取/写入 Token，`output` 为输出，`totalTokens` 为总量。`cache.model_input.hit_rate` 是缓存读取 Token 占全部输入 Token（未缓存 + 读取 + 写入）的比例，无输入时为 `null`。不存在跨 run 结果缓存。`quality` 记录具有新提交统计的任务数量、首次通过率、重复错误率、修复次数、attempts/Token 及 P50/P95；缺少新统计的历史收据不推算首次通过率。

加 `--debug` 才会额外保留 `_internal/`。该设置写入 `state.json`，后续同 ID 继续运行时沿用；可以给已有普通运行加 `--debug`，此前未保存的日志不会补回。

| debug 文件 | 用途 |
|---|---|
| `_internal/contract.json`、`_internal/output_schema.json` | 提示词、契约与 schema 快照 |
| `_internal/tasks/<id>/attempt-NNN/attempt.json` | 尝试的参数 `spec`、终态 `status`、最终用量与审计 `metrics`、失败原因及未接受的最后一次提交；未收齐的字段缺省 |
| `_internal/tasks/<id>/attempt-NNN/events.jsonl.gz` | 尝试的压缩执行日志 |
| `_internal/tasks/<id>/artifacts/` | 成功及失败尝试的脚本、stdout/stderr 和生成文件 |
| `_internal/diagnostics/` | 有记录才生成的 `failures.jsonl`、`skipped.jsonl`、`not_comparable.jsonl`；`correctness.jsonl` 只包含实际独立评测，不生成占位行 |
| `_internal/exports/` | `report --details` 按需生成的 `task_summaries.jsonl`、`task_outcomes.jsonl`；后续重建报告时一并刷新 |

接受提交时先原子保存待落盘收据，再向结果 JSONL 追加并刷盘，随后将状态中的判决正文替换为结果引用。两次写入之间崩溃可从待落盘收据恢复；完成后正式 JSONL 是判决的唯一持久存储，不能删除它来清理空间。状态保留恢复原始提交所需的少量字段差异，以便同一提交 UUID 重发时确认内容一致。续跑清除重复行和中断尾行；已压缩为引用的正式结果若丢失则明确报错，不自动重评。

`report` 重建展示并使旧校验结果失效；`validate` 分别报告正式结果、证据关系和可选附件。附件未保存或缺失不撤销成功收据，也不产生结果缺失错误。普通模式切 debug 不补造历史附件或重评成功任务。`report` 可从已接受的正式结果生成展示；`validate` 从原始输入校验证据。原文件修改或删除后，旧结果保留，证据校验会明确报告材料不可用，不触发重评。两条命令不调用模型；`report --details` 仅用于 debug 运行。

输入只长期保留在原始数据源。`state.json` 保存源文件路径、行号和文件系统修订信息，不保存消息正文，也不计算哈希。Worker 工作区中的 `inputs/` 是执行期间的临时材料，完成后清除，不归档到 run。普通模式的 Worker 工作区临时存在，清理前保存最后草稿、错误与用量；debug 模式额外收集事件和产物，收集不完整时保留 Worker 副本。debug 事件运行中追加 `events.jsonl`，收集结束后压缩，崩溃时可能保留未压缩日志。

## 独立运行 Worker

默认由 Host 管理 Worker 进程。需要单独启动时：

```bash
npm run start --workspace @eval/agent-pi -- --port 4101
npm run start --workspace @eval/agent-prime -- --port 4102
npm run eval -- run --engine pi --worker http://127.0.0.1:4101 --run-id external-001
```

外部 Worker 由调用方管理，所有进程使用相同的模型 URL 和 key。Worker 只监听回环地址，适用于可信单机调用。

代码工具工作目录不是安全沙箱；取消、超时和 Worker 退出会回收所属进程组。需要隔离不可信代码时，应在受限部署环境运行整个系统。
