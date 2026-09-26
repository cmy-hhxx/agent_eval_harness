# 使用指南

[返回首页](../README.md) · 输入和结果语义见[数据契约](contract.md)。

## 最短路径

1. 创建 `.env`，填写 `EVAL_BASE_URL` 和 `EVAL_API_KEY`。
2. 复制 `configs/models.example.json` 为 `configs/local/models.json`，填写模型 ID。
3. 先预检，再运行；同一个 `run-id` 会续跑未完成任务。

```bash
npm run eval -- preflight
npm run eval -- run --engine pi --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json
npm run eval -- status --run data/runs/comparison/pi-001
npm run eval -- report --run data/runs/comparison/pi-001
```

配置字段见下文；恢复、产物和 Worker 细节分别见[运行与恢复](#运行与恢复)、[运行产物](#运行产物)和[独立运行 Worker](#独立运行-worker)。

## 环境与配置

工具版本由 [mise.toml](../mise.toml) 固定。安装步骤见首页。根 `.venv` 供公共 Python 代码工具使用；Prime 自身的 runtime 位于 `.runtime/prime-python`，两者独立。

根 `.env` 只保存两种底座共用的网关地址与密钥，不存放任何模型选择：

```dotenv
EVAL_BASE_URL=https://api.openai.com/v1
EVAL_API_KEY=your-key
```

将 URL 换成实际网关地址，保留网关要求的 `/v1` 路径。`npm run eval`、`npm run doctor` 和 `npm run worker` 自动读取根 `.env`；已有环境变量优先。切换 `--engine pi|prime` 不需要更换变量名或复制密钥。`.env` 不入库，示例见 [.env.example](../.env.example)。

模型与评测配置通过配置文件接口注入。`--config` 可重复，文件按出现顺序深度合并，相对路径按各自文件目录解析：

| 配置 | 含义 |
|---|---|
| `inputs.versions` | 版本 ID、展示名称、输入适配器与来源；`adapter` 引用已注册的输入结构，`sources` 用 `file`（单文件）或 `directory`（递归按 `include` 的 basename 匹配，缺省全部 `*.jsonl`）描述，可多个 |
| `inputs.timing_unit` | 原始耗时单位，`ms` 或 `s` |
| `comparisons` | 对比组，每项是一组已登记版本；组内所有版本在同一次判断中排名，不限定数量 |
| `models` | 命名模型档案：`provider`、`baseUrlEnv`、`api`、`apiKeyEnv` 及默认 `thinking`、`contextWindow`、`maxOutputTokens` |
| `bindings` | 评测阶段到模型档案的绑定，可按阶段覆盖 `model`、`thinking`、`contextWindow`、`maxOutputTokens` |
| `execution` | 并发、超时、工具预算、修正和重试 |
| `output` | 运行产物目标：`{ kind: "directory", path }`；Host 在其下创建 `<run-id>` 子目录 |
| `attribution` | 归因树目标：`{ kind: "directory", path }`；每个模型一棵 `<version>.json`，跨 run 累积 |

入库的 [configs/host.json](../configs/host.json) 只定义共享的输入、执行预算和模型档案骨架，不含具体模型 ID。具体模型放在不入库的本地配置：

```bash
cp configs/models.example.json configs/local/models.json
# 编辑 configs/local/models.json，填入网关提供的模型 ID
npm run eval -- run --engine pi --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json
```

同一档案可被多个阶段复用，阶段差异只写在 `bindings`，不复制整段模型配置。`preflight`、`doctor`、`status`、`report` 不需要具体模型；只有 `run` 会解析全部绑定并要求模型 ID 与密钥齐全。`--input <版本 ID>=<路径>` 与 `--output <目录>` 可临时覆盖配置中的来源与目标。模型档案与解析见 [models.ts](../apps/host/src/models.ts)，评测配置见 [EvalConfig](../packages/workflows/src/comparison/types.ts)，输入/输出接口见 [InputSource / OutputTarget](../packages/contracts/src/index.ts)，运行目录布局见 [run-layout.ts](../packages/data/src/run-layout.ts)，通用预算默认值见 [DEFAULT_POLICY](../packages/contracts/src/index.ts)，加载与合并见 [loadConfig](../apps/host/src/config.ts)。

## 目录约定

| 位置 | 内容 | 是否入库 |
|---|---|---|
| `configs/host.json` | 共享评测配置与模型档案骨架，路径相对于配置文件目录 | 是 |
| `configs/models.example.json` | 本地模型配置模板，复制为 `configs/local/models.json` 后填写模型 ID | 是 |
| `configs/local/` | 本机配置（如 `models.json`），可覆盖或补充共享配置；路径同样相对于配置文件目录 | 否 |
| `data/sources/<dataset>/<batch>/` | 原始输入；当前回答数据集为 `model-answers`，每批保存四份候选 JSONL | 否 |
| `data/runs/<workflow>/<run-id>/` | 一次运行的状态、结果和报告；当前工作流为 `comparison` | 否 |
| `log/runtime.log`、`log/evaluation.log` | 全项目共用的错误日志和业务日志 | 否 |
| `.cache/npm/`、`.cache/uv/` | 下载缓存 | 否 |
| `.runtime/`、`.venv/`、`dist/` | 可重建的执行环境和构建产物 | 否 |
| `.artifacts/` | 开发验证日志、临时计划和检查结果 | 否 |

目录按对象分区，数据集可供不同工作流和 run 引用。当前默认布局：

```text
configs/
  host.json                      # 共享评测与模型档案骨架
  models.example.json            # 本地模型配置模板
  local/                         # 本机配置（models.json 等）
data/
  sources/model-answers/
    0922/                        # a_fast.jsonl、a_expert.jsonl、aa_fast.jsonl、aa_expert.jsonl
    0923/
    0924/
  attribution/
    a_fast.json                  # 每个模型一棵归因树：组件/问题节点 + 出现样本 + 血缘事件
    aa_fast.json
  runs/comparison/
    <run-id>/
      state.json                 # 输入引用、任务进度、收据索引和草稿
      results/                   # 正式评测 JSONL
      report.md
      task_summaries.md
      stats.json
      _internal/                 # 仅 debug
```

归因树是每个模型的跨 run 问题库，归因 Agent 优先召回已有节点、只在没有对应问题时新建；对比 Agent 只确认、不新建节点。每次 `report`/run 结束会把已接受的归因收据合并进树，按 `(节点, 输入, finding)` 幂等。节点 ID 用持久化 UUID，合并/重分类保留 `previous_node_id` 与 `events`，每个出现样本保留 `batch/case/version/input_id` 与源文件行号，可从问题反查到样本、再回到原始数据。当前一个模型一棵树，`tree_version`/`previous_tree` 预留后续分版本。

新增批次放入数据集目录即可；`sources` 按 `include` 的 basename 递归匹配，新增日期目录无需改配置。批次身份取 JSON 中的 `batch_id`，目录名只用于整理；用 `--batch` 按实际 `batch_id` 选择，`--input` 可把某个版本指向其他文件或目录。`output.path` 指向工作流目录，Host 再创建 `<run-id>` 子目录。不同 run 隔离产物，同一 run 只有一个 Host 写入；原始输入不复制到 run。

输入只做记录有效性校验，不因文件元数据变化阻止续跑。`state.json` 登记每个版本的来源路径与行号供恢复与证据核对；证据按业务标识（`batch_id + case_id + version`）定位，文件的追加或整理不影响已接受结果。未完成任务的来源缺失或无效时，该任务会被跳过并在预检诊断中报告，不中断整个 run。运行 ID、任务 ID、输入 ID 和盲测映射与目录无关。

## 日志

应用启动时创建项目根目录的 `log/`，其中只有两个文件，均为 UTF-8 单行 JSON，追加写入，不按日期或 run 分文件：

| 文件 | 写入内容 |
|---|---|
| `runtime.log` | 命令异常、预检或校验失败、任务最终失败，以及附件收集和 Worker 清理失败。包含时间、组件、事件、错误及可用的 run/task/attempt 标识；异常带截断后的堆栈。 |
| `evaluation.log` | 已通过校验并写入正式结果文件的评测输出。每行对应一份已接受收据，附运行、任务、阶段和提交标识，`result` 为 Workflow 规整后的结果。涵盖归因与对比结果。 |

运行日志对同组件、事件、run 和错误消息在 60 秒内只保留首条，保留该条的任务定位信息。进度、心跳、模型流、工具调用和修复成功的中间错误不写入运行日志。已配置的模型密钥会脱敏。

业务日志按 Workflow、run、任务和提交 ID 去重，重复提交与续跑不会重复追加；续跑会补齐该 run 已接受但尚未记入日志的结果，不触发重评。`report` 和 `validate` 不重复记录业务结果。正式结果和恢复状态仍存放在 run 目录，日志不是续跑数据源。日志写入失败只向 stderr 提示，不撤销已经接受的判决。

多个 Host 与独立 Worker 共用同一套日志。写入锁放在 `.runtime/log-writer/`，日志目录不生成索引或轮转文件。追加前读取其他进程新增的完整行，崩溃留下的未完成末行在下次写入时清除；已完成行损坏则报告错误，保留原文件。日志持续追加，如需手动清理，应先停止写入进程。

```bash
tail -f log/runtime.log
tail -f log/evaluation.log
```

日志类型见 [LogSink / EvaluationLog](../packages/contracts/src/index.ts)，文件写入与去重实现在 [logging.ts](../packages/data/src/logging.ts)。

## 运行与恢复

```bash
npm run eval -- preflight
npm run eval -- run --engine pi --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json
npm run eval -- run --engine prime --run-id prime-001 \
  --config configs/host.json --config configs/local/models.json
npm run eval -- run --engine pi --run-id pi-debug --debug \
  --config configs/host.json --config configs/local/models.json
npm run eval -- status --run data/runs/comparison/pi-001
npm run eval -- report --run data/runs/comparison/pi-001
npm run eval -- validate --run data/runs/comparison/pi-001
npm run eval -- report --run data/runs/comparison/pi-debug --details
```

`preflight` 加载配置并检查输入，需要配置模型 URL，但无需密钥和具体模型，也不请求模型；有输入问题返回退出码 2。汇总包含每个版本解析到的文件（`sources`）与逐批次样本数。没有有效对比组时拒绝新建运行。`--config` 可重复以组合共享配置与本地模型配置；`--input ID=PATH`、`--output DIR` 可临时覆盖来源与目标；`--batch ID`、`--case ID` 可重复；`--limit-cases N` 按批次与 case 排序截取，不保证首题有有效对比组。

输入的每日批次约定见[数据契约](contract.md#输入)。不指定 `--batch` 时处理全部输入批次，多个 `--batch` 取并集，并与 `--case` 条件取交集。批次 ID 使用输入 JSON 中的实际 `batch_id`（目录名只用于整理，不参与筛选）。同 case 出现在不同批次时分别计数，`--limit-cases` 限制整个选择结果的样本数。以下命令按实际批次 ID 选择：

```bash
npm run eval -- preflight --batch <batch_id>
npm run eval -- run --engine pi --run-id daily-a --batch <batch_id_a> --batch <batch_id_b> \
  --config configs/host.json --config configs/local/models.json
```

再次执行相同 `--run-id` 自动续跑。Host 从 `state.json` 读取任务索引、源文件引用、预检诊断、收据、修复草稿和累计用量，A/B 分配不再重建。代码、模型和预算变化不阻止续跑；已接受的任务始终保留，其他 run 不复用结果。模型服务端缓存行为保持不变。

续跑沿用原运行的批次、case 和数量筛选条件，按 `batch_id + case_id + 阶段 + 版本组合` 识别任务；本次传入的 `--batch`、`--case`、`--limit-cases` 不替换原范围。已经接受的归因和对比结果不再评测，即使原输入、标准答案或模型参数发生变化。未完成任务使用最新有效输入，并加入原选择范围内的新增对比组；无效或冲突记录不能覆盖未完成任务，未完成任务的来源缺失或无效时使该任务跳过并记入预检诊断，不中断其他任务。需要新增日期批次或重新评测已完成样本时使用新 run ID。若某份归因收据已接受，而对比尚未完成，对比仍使用这份收据；想让两阶段都基于修改后的材料评测，同样需要新 run ID。累计 attempts 和已记录的 Token 保留历次执行成本。运行退出码：0 成功、2 有失败、130 被中断。

内容修复、文件加载和传输错误使用独立预算。内容失败最多自动开启一次跨 attempt 续修，带入最后草稿和结构化反馈；连续两次出现相同字段、错误码及实际错误时停止。每次内容修复预留一次材料或代码工具调用；每 attempt 最多三次文件加载失败，路径/读取/JSON 解析错误不消耗内容修复次数。连接与流中断按 `execution.retries` 有界退避。

运行中可调整并发并查看进度：

```bash
npm run eval -- concurrency --run data/runs/comparison/pi-001 --value 8
npm run eval -- progress --run data/runs/comparison/pi-001
```

提高并发立即唤醒调度器并按需启动托管 Worker；降低并发停止补位，让健康任务自然完成。外部 Worker 只调整使用数量。默认并发保持配置值。进度包含排队、运行、接受、修复、失败分类、近期吞吐和最长无进展任务；至少五个耗时样本后才提供 ETA 区间。

### 本机运行看板

启动一个只监听 `127.0.0.1` 的简易看板：

```bash
npm run eval -- dashboard --port 4173
```

打开终端输出的地址即可查看 `data/runs/comparison` 中的运行、任务状态和只读 Host 配置。看板可以启动 Pi / Prime 运行、停止当前运行，并用相同 run ID 继续未完成任务；停止不会删除已接受结果。停止操作通过当前 run 的锁令牌转发给 Host，页面不保存输入正文或模型密钥。看板不提供远程认证，不应绑定到公网地址。

## 运行产物

所有交付文件位于 `data/runs/comparison/<run-id>/`，不生成 ZIP、tar 等压缩交付包。默认包含 `report.md`、`task_summaries.md`、`results/`、`state.json` 和 `stats.json`；运行中的 `.run-lock` 在退出时释放。

| 文件 | 用途 |
|---|---|
| `report.md` | 总览、分批样本、排名与对局矩阵、异常数量、用量缺失和校验状态 |
| `results/comparison.jsonl` | 每组的正式对比结果（排名、核心判定与派生两两判决），接受后追加并刷盘，运行中即可读取 |
| `results/attribution.jsonl` | 每条回答的归因判决与证据，按任务 ID 引用，成功提交后追加并刷盘；每条回答都会归因 |
| `task_summaries.md` | 以 `batch_id / case_id` 标识逐题结论、双方优缺点、耗时，以及失败、输入跳过原因和输入异常 |
| `state.json` | 唯一进度账本：任务与输入索引、批次范围、预检、结果引用、待修草稿与错误、累计用量；候选信息仅登记一次 |
| `stats.json` | 数量、对局胜出、Token、缓存命中、耗时和校验汇总，以及 `artifacts` 产物清单；不包含逐题 ID 或异常明细 |

`stats.json` 保存 `standings`（每个版本参赛数、完成核心要求、首位、平均层、胜/都好/都差）、派生的 `head_to_head` 对局矩阵与 `per_version`；`by_batch` 按批次保存数量与对比口径，字段口径与总体统计一致。`artifacts` 列出权威结果目录、结果文件、报告和状态文件。失败和待完成按任务计数，计划任务包含归因和对比阶段；有效比较统计派生判决中的胜出、都好、都差。正式 JSONL 继续通过 `case.batch_id` 区分批次。Token、耗时和缓存统计保持全局口径。

`stats.json` 的 `tokens` 汇总所有已记录尝试，包含失败和重试；未取得最终用量的尝试计入 `attempts_without_final_metrics`，不能视作用量为零。`input` 为未命中缓存的输入，`cacheRead` / `cacheWrite` 为缓存读取/写入 Token，`output` 为输出，`totalTokens` 为总量。`cache.model_input.hit_rate` 是缓存读取 Token 占全部输入 Token（未缓存 + 读取 + 写入）的比例，无输入时为 `null`。不存在跨 run 结果缓存。

`quality` 的首次通过率和修复次数按有内容提交计数的任务统计，包含归因和对比阶段；无计数的任务不推算。`attempts_per_accepted_task` / `tokens_per_accepted_task` 是累计尝试数 / Token 除以已接受任务数。P50/P95 使用各任务已记录的累计 attempt 耗时，包含失败与重试，不是单次模型响应时间；`wall_seconds` 从首次启动计时，包含中途停机到续跑之间的间隔。

加 `--debug` 才会额外保留 `_internal/`。该设置写入 `state.json`，后续同 ID 继续运行时沿用；可以给已有普通运行加 `--debug`，此前未保存的日志不会补回。

| debug 文件 | 用途 |
|---|---|
| `_internal/contract.json`、`_internal/output_schema.json` | 提示词、契约与 schema 快照 |
| `_internal/tasks/<id>/attempt-NNN/attempt.json` | 尝试的参数 `spec`、终态 `status`、最终用量与审计 `metrics`、失败原因及未接受的最后一次提交；未收齐的字段缺省 |
| `_internal/tasks/<id>/attempt-NNN/events.jsonl.gz` | 尝试的压缩执行日志 |
| `_internal/tasks/<id>/artifacts/` | 成功及失败尝试的脚本、stdout/stderr 和生成文件 |
| `_internal/diagnostics/` | 有记录才生成的 `failures.jsonl`、`skipped.jsonl` |
| `_internal/diagnostics/validation.json` | `validate` 发现正式结果错误时写出的校验详情；完整当次诊断也会输出到终端 |
| `_internal/exports/` | `report --details` 按需生成的 `task_summaries.jsonl`、`task_outcomes.jsonl`；后续重建报告时一并刷新 |

归因与对比阶段均在接受提交时先原子保存待落盘收据，再向结果 JSONL 追加并刷盘，随后将状态中的判决正文替换为结果引用。成功任务清除失败草稿和错误上下文，保留提交统计及重复错误计数。两次写入之间崩溃可从待落盘收据恢复；完成后正式 JSONL 是判决的唯一持久存储，不能删除它来清理空间。状态保留恢复原始提交所需的少量字段差异，以便同一提交 UUID 重发时确认内容一致。续跑可清除相同的重复行和中断尾行，冲突结果会报错；已压缩为引用的正式结果若丢失则明确报错，不自动重评。

`report` 按已接受收据重建结果 JSONL、Markdown 和统计，并使旧校验结果失效；已有结果引用可用于重建，无需重新读取输入。`validate` 分别报告正式结果、证据关系和可选附件。附件未保存或缺失不撤销成功收据，也不产生结果缺失错误。普通模式切 debug 不补造历史附件或重评成功任务。原文件修改或删除后，旧结果保留，证据按业务标识定位：记录仍可找到则视为有效，找不到时才报告材料不可用，不触发重评。两条命令不调用模型；`report --details` 仅用于 debug 运行。

输入只长期保留在原始数据源。`state.json` 保存源文件路径与行号供恢复和证据核对，不保存消息正文，也不计算内容哈希；项目校验限制见[开发指南](development.md#禁止项目哈希与兼容层)。Worker 工作区中的 `inputs/` 是执行期间的临时材料，完成后清除，不归档到 run。普通模式的 Worker 工作区临时存在，清理前保存最后草稿、错误与用量；debug 模式额外收集事件和产物，收集不完整时保留 Worker 副本。debug 事件运行中追加 `events.jsonl`，收集结束后压缩，崩溃时可能保留未压缩日志。

## 独立运行 Worker

默认由 Host 管理 Worker 进程。需要单独启动时：

```bash
npm run worker -- --engine pi --directory .runtime/workers/pi-1 --port 4101
npm run worker -- --engine prime --directory .runtime/workers/prime-1 --port 4102
npm run eval -- run --engine pi --worker http://127.0.0.1:4101 --run-id external-001 \
  --config configs/host.json --config configs/local/models.json
```

外部 Worker 由调用方管理，所有进程使用相同的模型 URL 和 key。Worker 只监听回环地址，适用于可信单机调用。

代码工具工作目录不是安全沙箱；取消、超时和 Worker 退出会回收所属进程组。需要隔离不可信代码时，应在受限部署环境运行整个系统。
