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
| `inputs.versions` | 文件与版本 ID、展示名称、A / AA 适配器的对应关系 |
| `inputs.timing_unit` | 原始耗时单位，`ms` 或 `s` |
| `judge.baseUrlEnv` / `judge.apiKeyEnv` | 共用 URL / key 的环境变量名 |
| `judge.api` | `openai-completions` 或 `openai-responses` |
| `judge.correctness` / `judge.pairwise` | 各阶段的模型、thinking、上下文和输出 token 上限 |
| `execution` | 并发、超时、工具预算、修正、重试和盲测种子 |
| `outputDir` / `cacheDir` | 运行产物和任务缓存 |

配置中的相对路径相对于配置文件目录解析。完整类型见 [EvalConfig](../packages/pairwise-eval/src/types.ts)，预算默认值见 [DEFAULT_POLICY](../packages/contracts/src/index.ts)。不在文档复制一套默认值。

## 目录约定

| 位置 | 内容 | 是否入库 |
|---|---|---|
| `data/inputs/` | 四个版本的原始 JSONL | 否 |
| `data/runs/<run-id>/` | 当前 Host 的全部运行产物 | 否 |
| `.cache/evaluations/` | 当前任务缓存 | 否 |
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

再次执行相同 `--run-id` 即自动续跑，无需额外参数。Host 从 `state.json` 读取任务进度，已完成结果从 `results/` 读取；两者一起保留。已完成任务不会再次调用模型，失败、中断等未完成任务从新 attempt 开始。代码、提示词、模型、预算、种子和底座变化不阻止续跑，未完成任务使用当前执行参数。任务清单与 A/B 分配按状态中保存的输入配置和种子重建；debug 模式直接读取计划快照。需要重新评测全部题目或更换任务清单时使用新 run ID。运行退出码：0 成功、2 有失败、130 被中断。

模型连接错误和流中断按 `execution.retries` 重试；提交修正预算耗尽会保留具体原因，不作为网络错误自动重试。Pi 会将工具拒绝反馈标记为 SDK 工具错误，供模型修正后重新提交。

## 运行产物

所有交付文件位于 `data/runs/<run-id>/`，不生成 ZIP、tar 等压缩交付包。默认只有 `report.md`、`task_summaries.md`、`results/`、`state.json` 和 `stats.json`；运行中的 `.run-lock` 在退出时释放。

| 文件 | 用途 |
|---|---|
| `report.md` | 总览、异常数量、用量缺失和校验状态 |
| `results/<pair>.jsonl` | 正式配对结果 |
| `results/not_comparable.jsonl` | 不可比较结果，有记录时才生成，不计入正式比较数量 |
| `task_summaries.md` | 逐题结论、双方优缺点、耗时，以及失败、不可比较和输入跳过原因 |
| `state.json` | 续跑索引：配置、任务进度、收据元数据、结果引用和累计用量；每个任务一行，不重复保存已导出的评语和完整任务材料 |
| `stats.json` | 仅保留数量、配对胜出、Token、缓存命中、耗时和校验汇总，不包含逐题 ID 或异常明细 |

`stats.json` 的 `tokens` 汇总所有已记录尝试，包含失败和重试；`input` 为未命中缓存的输入，`cacheRead` / `cacheWrite` 为缓存读取/写入 Token，`output` 为输出，`totalTokens` 为总量。`cache.model_input.hit_rate` 是缓存读取 Token 占全部输入 Token（未缓存 + 读取 + 写入）的比例，无输入时为 `null`。`cache.task_results` 统计已接受收据中标记为缓存复用的数量和比例，包括导入时标记为缓存的收据；复用的历史用量不会重复计入当前尝试用量。

加 `--debug` 才会额外保留 `_internal/`。该设置写入 `state.json`，后续同 ID 继续运行时沿用；可以给已有普通运行加 `--debug`，此前未保存的日志不会补回。

| debug 文件 | 用途 |
|---|---|
| `_internal/contract.json`、`_internal/output_schema.json` | 提示词、契约与 schema 快照 |
| `_internal/inputs.jsonl.gz` | 按内容 ID 去重的完整输入快照，每行 `{id,value}` |
| `_internal/plan.json` | 完整任务清单及输入预检明细 |
| `_internal/tasks/<id>/attempt-NNN/attempt.json` | 尝试的参数 `spec`、终态 `status`、最终用量与审计 `metrics`、失败原因及未接受的最后一次提交；未收齐的字段缺省 |
| `_internal/tasks/<id>/attempt-NNN/events.jsonl.gz` | 尝试的压缩执行日志 |
| `_internal/tasks/<id>/artifacts/` | 成功及失败尝试的脚本、stdout/stderr 和生成文件 |
| `_internal/diagnostics/` | 有记录才生成的 `failures.jsonl`、`skipped.jsonl`、`not_comparable.jsonl`；`correctness.jsonl` 只包含实际独立评测，不生成占位行 |
| `_internal/exports/` | `report --details` 按需生成的 `task_summaries.jsonl`、`task_outcomes.jsonl`；后续重建报告时一并刷新 |

接受提交时先原子保存收据；`report` 写入结果后，将状态中的完整配对评语替换成结果引用。尚未导出的提交和依赖任务所需的正确性结论暂存于状态中，避免中断丢失。`report` 可以补写未导出的结果并重建报告、统计，使旧校验结果失效；`validate` 检查结果引用、证据和导出映射，统计中只记录错误数量，详细错误由命令输出，debug 模式另存诊断。默认读取原始输入，debug 模式使用自身快照并额外校验附件字节。两者均不调用模型。`report --details` 仅用于 debug 运行；崩溃时缺失的完整用量会显式标记。

默认模式的托管 Worker 在系统临时目录工作，结束时清理；任务缓存仍位于配置的 `cacheDir`。debug 模式的输入快照独立于 `data/inputs/`，保留原始消息、图片和元数据。成功、失败及取消的尝试均在 Host 收齐事件、最终记录和工具产物后释放 Worker 副本；收集不完整时保留在 `_internal/workers/`。debug 事件在运行中追加到 `events.jsonl`，Host 结束收集后压缩；进程崩溃时可能留下未压缩日志。

## 独立运行 Worker

默认由 Host 管理 Worker 进程。需要单独启动时：

```bash
npm run start --workspace @eval/agent-pi -- --port 4101
npm run start --workspace @eval/agent-prime -- --port 4102
npm run eval -- run --engine pi --worker http://127.0.0.1:4101 --run-id external-001
```

外部 Worker 由调用方管理，所有进程使用相同的模型 URL 和 key。Worker 只监听回环地址，适用于可信单机调用。

代码工具工作目录不是安全沙箱；取消、超时和 Worker 退出会回收所属进程组。需要隔离不可信代码时，应在受限部署环境运行整个系统。
