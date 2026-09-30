# 使用指南

持续监控远程输入并自动完成所有评测阶段，见 [Automations 流水线](automations.md)。

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
| `evaluatorVersion` | 评测器标识，必填非空字符串；写入每条正式结果的 `evaluator_version`，影响判词的变更必须更新它，详见[契约](contract.md#评测器版本标识) |
| `inputs.versions` | 版本 ID、展示名称、输入适配器与来源；`comparison_tier` 可声明模型规模档位（默认 A/B 的 Fast 或 Expert）；`adapter` 引用已注册的输入结构，`sources` 用 `file`（单文件）或 `directory`（递归按 `include` 的 basename 匹配，缺省全部 `*.jsonl`）描述，可多个 |
| `inputs.timing_unit` | 原始耗时单位，`ms` 或 `s` |
| `comparisons` | 对比组，每项是一组已登记版本；组内统一排名，不能混用不同 `comparison_tier`；未标档位的第三方模型可加入任一组 |
| `rewrite` | 改写开关：`{ comparison, attribution, clustering }`；默认只开启comparison并改写对局偏好理由；`comparisonItems: true` 将逐项点评加入同一改写任务，自动化强制开启；开启后每个归因/对比/聚类任务对应一个改写任务，源结果接受后执行，结果写回各阶段自身的 `rewritten` 字段；启用时必须有 `bindings.rewrite` |
| `models` | 命名模型档案：`provider`、`baseUrlEnv`、`api`（当前统一为 `openai-responses`）、`apiKeyEnv` 及默认 `thinking`（缺省 `xhigh`）、`contextWindow`、`maxOutputTokens` |
| `bindings` | 评测阶段到模型档案的绑定，可按阶段覆盖 `model`、`thinking`、`contextWindow`、`maxOutputTokens` |
| `execution` | 并发、超时、工具预算、修正和重试；仓库配置默认32并发，连续120秒没有模型/工具进展触发空闲超时，单任务总期限900秒 |
| `execution.failureGuard` | 同类失败熔断：`{ windowSize: 50, threshold: 5 }`；同阶段最近50个不同任务中，同类别、错误码与归一化字段路径达到5次时暂停该阶段；两者为整数，`windowSize >= threshold >= 2` |
| `output` | 运行产物目标：`{ kind: "directory", path }`；Host 在其下创建 `<run-id>` 子目录 |
| `problemLibrary` | 问题库目标：`{ kind: "directory", path }`；每个模型一份 `<version>.json`，跨 run 累积，只由聚类阶段写入 |
| `clustering` | 问题库上限与预算：`enabled`、`maxClassesPerModel`、`maxNewClassesPerTask`、`maxComponentsPerModel`、`consolidateAt`、`minSupport`、`maxCasesPerTask`；启用时必须有 `bindings.clustering` |

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
| `data/sources/<dataset>/<model>/<date>.jsonl` | 原始输入；当前回答数据集为 `model-answers`，每个模型一个目录、每个评测运行日一份文件 | 否 |
| `data/input-catalog/<dataset-id>/` | 本地评测集索引：`index.json` 汇总与逐行位置 JSONL，无原始消息 | 否 |
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
    a_fast/2026-09-22.jsonl      # 模型目录；文件名是该次评测的运行开始日
    a_expert/2026-09-22.jsonl
    b_fast/2026-09-22.jsonl
    b_expert/2026-09-22.jsonl
    _daily/2026-09-22.json       # 每日清单：批次与各模型行数/case 数
  input-catalog/
    competitor_comparison/
      index.json                 # 评测集名称、模型文件与汇总；记录文件指针
      records-<uuid>.jsonl      # 行号、UTF-8 字节范围、批次/case 与错误码
  problems/
    a_fast.json                  # 每个模型一份问题库：组件 + 问题类 + 出现样本 + 血缘事件
    b_fast.json
  runs/comparison/
    <run-id>/
      state.json                 # 输入引用、任务进度、收据索引和草稿
      results/                   # 正式评测 JSONL 与 clustering.jsonl
      report.md
      task_summaries.md
      stats.json
      _internal/                 # 仅 debug
```

每个模型维护一份跨 run 问题库，只有聚类阶段能写入：归因 Agent 只输出问题描述，聚类 Agent 先把问题归入已有类、确实没有才在预算内新建，必要时合并近义类。每次 `report`/run 结束会把已接受的聚类收据应用进库，即使续跑时关闭聚类也会保留并应用已接受收据；按 `(class_id, input_id, finding_id)` 幂等，重复报告不刷新未变化库的时间戳。`stats.json` 的 `problem_library` 与 `report.md` 记录当前类数、出现样本数以及本 run 的归类数、提议新类数和合并决定数（提议数不等于实际新增数）。类 ID 用持久化 UUID，合并保留 `previous_class_id` 与 `class_merged`/`occurrence_moved` 事件，被合并类的 label/aliases 追加到目标类；每个出现样本保留 `batch/case/version/input_id`、`evidence_status`（已确认或待核实）与源文件行号，可从问题类反查到样本、再回到原始数据。数量由程序硬控：每模型活跃类上限（默认 80）+ 每次任务新增预算（默认 8）+ 达到 60 类时提示合并整理。跨 run 更新按模型上锁；所有模型的上限校验完成前不写库。

新增评测日只需在对应模型目录放入 `YYYY-MM-DD.jsonl`（文件名用评测运行开始日），`sources` 直接指向模型目录，无需修改配置；跨天任务归开始日。批次身份取 JSON 中的 `batch_id`，目录和文件名只用于整理；用 `--batch` 按实际 `batch_id` 选择，`--input` 可把某个版本指向其他文件或目录。每天一份 `_daily/<日期>.json` 清单记录该日的批次与各模型行数/case 数，只用于核对，不参与评测。`output.path` 指向工作流目录，Host 再创建 `<run-id>` 子目录。不同 run 隔离产物，同一 run 只有一个 Host 写入；原始输入不复制到 run。

续跑会重新读取原始记录，不因评测集索引或文件元数据变化而拒绝恢复。`state.json` 登记每个版本的来源路径与行号供恢复与证据核对；证据按业务标识（`batch_id + case_id + version`）定位，文件的追加或整理不影响已接受结果。未完成任务的来源缺失或无效时，该任务会被跳过并在预检诊断中报告，不中断整个 run。运行 ID、任务 ID、输入 ID 和盲测映射与目录无关。

运行规划和正式结果校验只在内存保留原始记录的字节位置，任务准备、提交校验和证据复核时再读取对应记录，不常驻整日回答正文。按记录读取仍检查文件修订和业务身份；启动后修改输入文件会中止受影响的读取，保存已接受结果后用同一 run 续跑即可读取新来源。

## 输入治理

日期文件和任务命名文件都可以登记为**评测集**；评测集 ID 是显式业务标识，不从目录或文件名推断。登记前先在 `inputs.versions` 注册被评模型（`id`、`name`、`adapter`），并在 `comparisons` 声明要比较的模型组合；新增模型不会自动加入已有组，同一 run 也不会追加新版本。各模型的同一 case 必须提供相同的 `batch_id + case_id`，问题和标准答案也不能冲突；单纯同名文件不能替代记录身份。已选评测集中，若记录没有 `batch_id` 且未配置 `inputs.default_batch_id`，使用评测集 ID 作为该记录的默认批次；记录已有的批次不变，同一评测集仍可含多个显式批次。被评模型与 `bindings` 中的判官模型是两回事。

以每个模型目录下的 `竞品对比.jsonl` 为例，先按文件显式登记，不要让目录扫描把每日输入一起索引进去：

```bash
npm run eval -- index --dataset competitor_comparison --dataset-name 竞品对比 \
  --input a_fast=data/sources/model-answers/a_fast/竞品对比.jsonl \
  --input a_expert=data/sources/model-answers/a_expert/竞品对比.jsonl \
  --input b_fast=data/sources/model-answers/b_fast/竞品对比.jsonl \
  --input b_expert=data/sources/model-answers/b_expert/竞品对比.jsonl \
  --config configs/host.json
npm run eval -- preflight --dataset competitor_comparison
npm run eval -- run --dataset competitor_comparison --engine pi --run-id competitor-001 \
  --config configs/host.json --config configs/local/models.json
```

默认配置将四模型分为 `a_fast + b_fast` 与 `a_expert + b_expert` 两组，各生成独立任务；不能将 Fast 和 Expert 放进同一组。只想对比其中两款模型时，在运行配置中声明同档位的对比组。`index` 可按一次评测所需的模型文件多次传入 `--input`；路径可以是文件或明确限定的目录。相同方式可给某个日期命名评测集。`--catalog <目录>` 可改变默认索引根目录 `data/input-catalog/`，索引和后续 `--dataset` 选择需使用同一目录。未传 `--dataset` 时，CLI 仍按 `inputs.versions[].sources` 扫描全部配置来源；`--dataset` 与临时 `--input` 不可混用。

`index.json` 只记录 ID、名称、索引时采用的默认批次、模型/适配器/文件路径、文件字节数与行数、有效/无效数量；逐行 JSONL 只记录文件序号、行号、UTF-8 字节偏移/长度、有效记录的 `batch_id + case_id` 或无效记录的错误码。**不存** `messages`、问题、答案、标准答案或内容哈希。无效和重复输入也能产出诊断索引，但 `--dataset` 拒绝选择；启动新 run 前会逐行核对索引与原始文件的字节坐标、业务标识和缺行，并重新校验记录，默认批次变更也须重新索引。修正文件后重新 `index`。新索引完整写入后才切换 `index.json` 指向的记录文件；原始 JSONL 不变，索引不作为正式结果缓存。`preflight` 会重新读取原始文件并校验业务冲突，`run` 按选中的源文件读取原始记录。同 run ID 续跑使用 `state.json` 中登记的来源，不依赖索引文件，即便再次传入 `--dataset` 也不会切换已有运行的来源（CLI 会提示忽略该选项）；索引更新不改变已接受判决。文件原路径消失时，历史结果仍保留，但证据核对可能报告材料不可用。

本机看板的输入选择目前仍按日期展示，命名文件会按其父目录兜底展示，尚不提供评测集选择；用上述 CLI 命令选择命名评测集。

## 日志

应用启动时创建项目根目录的 `log/`，其中只有两个文件，均为 UTF-8 单行 JSON，追加写入，不按日期或 run 分文件：

| 文件 | 写入内容 |
|---|---|
| `runtime.log` | 命令异常、预检或校验失败、任务最终失败，以及附件收集和 Worker 清理失败。包含时间、组件、事件、错误及可用的 run/task/attempt 标识；异常带截断后的堆栈。 |
| `evaluation.log` | 已通过校验并写入正式结果文件的评测输出。每行对应一份已接受收据，附运行、任务、阶段和提交标识，`result` 为 Workflow 规整后的结果。涵盖归因、对比和聚类结果；改写不单独记录，以及独立专业任务接受的结果。 |

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

再次执行相同 `--run-id` 自动续跑。Host 从 `state.json` 读取任务索引、源文件引用、预检诊断、收据、修复草稿和累计用量，A/B 分配不再重建。代码、模型、预算和评测器版本变化不阻止续跑；已接受的任务始终保留，其他 run 不复用结果。同一 run 可以混合多个 `evaluatorVersion`：已接受行保留各自版本，未完成任务使用当前配置的版本，行内 `evaluator_version` 与 `stats.json` 的 `evaluator_versions` 可区分。模型服务端缓存行为保持不变。

改写与聚类开关可以随续跑变化：开启后为已接受的归因/对比结果补齐改写任务、为该模型批次补齐聚类任务；关闭后不再计划未完成的对应任务；已接受的收据和正式评测结果都保留。

通过试跑或修复命令保存了 `executionScope` 时，续跑只执行清单内的任务，不重新规划输入，也不根据开关增加或删去任务。只读取范围内未完成任务实际需要的源记录；纯改写无需原始输入。范围完成后仍保留清单；显式 `run --discover-inputs` 才恢复原选择范围内的输入发现和规划。此选项不会重评成功任务，也不会扩大原先的日期、case 或数量限制。

续跑沿用原运行的批次、case 和数量筛选条件，按 `batch_id + case_id + 阶段 + 版本组合` 识别归因与对比任务，改写任务按 `批次 + case + 源任务 ID` 识别；本次传入的 `--batch`、`--case`、`--limit-cases` 不替换原范围。已经接受的归因、对比和改写结果不再评测，即使原输入、标准答案或模型参数发生变化。未完成任务使用最新有效输入，并加入原选择范围内的新增对比组；无效或冲突记录不能覆盖未完成任务，未完成任务的来源缺失或无效时使该任务跳过并记入预检诊断，不中断其他任务。需要新增日期批次或重新评测已完成样本时使用新 run ID。若某份归因收据已接受，而对比尚未完成，对比仍使用这份收据；想让两阶段都基于修改后的材料评测，同样需要新 run ID。累计 attempts 和已记录的 Token 保留历次执行成本。运行退出码：0 成功、2 有失败、130 被中断。

内容修复、文件加载和传输错误使用独立预算。内容失败最多自动开启一次跨 attempt 续修，带入最后草稿和结构化反馈；连续两次出现相同字段、错误码及实际错误时停止。每次内容修复预留一次材料或代码工具调用；每 attempt 最多三次文件加载失败，路径/读取/JSON 解析错误不消耗内容修复次数。连接与流中断按 `execution.retries` 有界退避。

续跑只推进尚可完成的任务、不重试已有失败项时，给 `run` 添加 `--skip-failed`。已有失败、超时及依赖阻塞状态保留；已接受结果始终保留，未完成及新增任务继续按各自依赖推进。

### 只补失败与同类故障熔断

停止该 run 的 Host 后，先预览再应用：

```bash
npm run eval -- retry-failed --run data/runs/comparison/daily-a
npm run eval -- retry-failed --run data/runs/comparison/daily-a --task <task-uuid> --apply
npm run eval -- run --run-id daily-a --config configs/host.json --config configs/local/models.json
```

不指定 ID 时选择失败、超时、取消和阻塞任务；`--task`、`--result` 可重复，后者使用正式 `comparison_id`。必要的未完成依赖与下游一起进入固定清单；共享聚类分片的其他依赖未完成时，不自动把它及其他题目拉入局部补跑。已成功任务不加入补跑；选择已成功的对比时，可以补它尚未完成的改写。预览列出任务、原状态和累计 attempts；`--apply` 只准备状态，随后同 run 续跑，不要求手改 `state.json`。其他未完成任务与后来追加数据不混入。零项选择不改状态。

Host 按每阶段、不同任务维护最近结果窗口；同一题的反复尝试不重复计数。错误路径中的数组下标归一化为 `*`，类别、错误码或其他路径不同则分别统计。触发后保存 `pausedStages`（阶段、错误签名、样例 task ID 和时间），停止该阶段新派发和后续 attempt 重试；已派发的 attempt 完成清理，其他健康阶段继续。暂停状态跨重启保留，未到阈值的统计窗口属于本次 Host 会话。容量不足在创建 attempt 前处理，不计为题目内容失败。

先依据样例定位并修复原因，再显式解除相应阶段；不能用重启绕过熔断：

```bash
npm run eval -- run --run-id daily-a --resume-stage rewrite \
  --config configs/host.json --config configs/local/models.json
```

`--resume-stage` 可重复，只接受当前已暂停的阶段；它保留固定修复范围。日志统一写 `log/runtime.log`，进度输出 `stage_paused`；同错误签名是诊断线索，不证明所有样本同根因。暂停和失败会使 CLI 返回2。

持续运行的 [Automations](automations.md#调度与状态) 会核对检查点，自动恢复中断任务，并对传输、超时及响应流中断退避续跑；结构、证据等持续校验错误仍保留保护性暂停。

### 小批验收再放量

新 run 用 `--pilot-cases N` 选择最多N场对比，按日期和模型组轮流抽取，并带上其归因与已开启的改写。聚类不进入试跑。完整计划保留；不要用会永久限制输入范围的 `--limit-cases` 代替试跑。

```bash
npm run eval -- run --run-id daily-a --batch <batch-id> --pilot-cases 40 \
  --config configs/host.json --config configs/local/models.json
npm run eval -- validate --run data/runs/comparison/daily-a --selected --require-rewrite verdicts
npm run eval -- rewrite-review --run data/runs/comparison/daily-a --limit-cases 50
# 按质量指南核对整场输出后，释放剩余任务；成功的试跑结果继续保留
npm run eval -- run --run-id daily-a --discover-inputs \
  --config configs/host.json --config configs/local/models.json
```

试跑并发取当前配置，可用本地配置先设为8。运行中逐级增加，检查各阶段净产出和错误，再决定下一档；一次配置过高会使故障发现前已有较多任务在途。分层抽样只保证日期与模型组覆盖，不保证语义边界覆盖；[固定反例与语义放量门槛](quality.md#改写放量验收)仍须逐项核对。普通结构检查成功不会自动批准放量。

运行中可调整并发并查看进度：

```bash
npm run eval -- concurrency --run data/runs/comparison/pi-001 --value 8
npm run eval -- progress --run data/runs/comparison/pi-001
```

提高并发立即唤醒调度器并按需启动托管 Worker；降低并发停止补位，让健康任务自然完成。并发槽位或 Worker 已满时暂停材料组装，空出槽位后再为待执行任务准备材料。独立任务并行处理启动与提交，同一任务仍按序防重；等待写盘的状态变更合并为检查点，确认持久化后才返回成功。已持久化或尚未提交的任务可立即查询收据，不等待其他任务写盘；正在提交的收据仍须等自身持久化完成。外部 Worker 只调整使用数量。进度的 `concurrency` 是目标上限，`in_flight_tasks` 是 Host 实际占用槽位（包含提交、清理与 attempt 间等待），不等于 HTTP 请求数；`stages` 按阶段给出排队、依赖就绪、执行、接受和最近一分钟接受数，另有 `paused_stages` 与 `execution_scope_count`。至少五个耗时样本且无阶段暂停时才提供任务级 ETA；它不是完整对比交付的时间承诺。

### 本机运行看板

在项目根目录运行一条命令启动看板：

```bash
bash run.sh
```

首次启动会安装依赖并构建两套 SDK，之后每次重建 Host 和看板；默认使用 `configs/host.json`，若存在 `configs/local/models.json`，还会加载本地模型配置。默认监听 `127.0.0.1:4173`，按 `Ctrl+C` 停止。与 `agent/run.sh` 相同，正常启动只显示准备状态，准备失败输出完整错误并退出；`--debug` 显示安装与构建诊断，不传给 dashboard。端口等 dashboard 参数直接追加，例如 `bash run.sh --port 4181`；需要自定义配置文件时也可直接使用 `npm run eval -- dashboard --port <端口> --config <配置文件>`。

打开终端输出的地址即可点击左侧运行，按批次和 case 查看问题与各版本最终回答，以及归因、对比任务的状态、正式输出与对应的改写状态和文案；日期先根据源文件名与目录显示，样本数量标为「扫描中」；后台逐行校验大 JSONL，仅保留样本索引，不把全部回答常驻内存。`/api/dashboard/inputs` 返回 `status=loading` 时样本为 `null`，完成后返回 `status=ready` 和核验数量；页面只在扫描期间轮询，完成前禁用预检。日期盘点、新运行预检和启动检查共用本看板进程内按文件保存的轻量输入索引，保留候选信息与校验错误，不保存原始回答或评测结果。每次预检按当前日期、模型、抽样数量和高级设置重新规划，读取当前问题库；选择变化不重读输入正文，来源修订或适配配置变化只重新解析受影响文件，并发请求共用正在进行的扫描，失败扫描不保留；启动仍验证网关模型、密钥与运行锁，评测子进程独立准备输入和校验，不复用评测结论。运行总览显示各阶段进度（含聚类）和该 run 结束时的 `stats.json` 问题库覆盖模型数，聚类按模型×批次统计、不挂在单个 case 上。运行总览下方是只读的「问题库」面板：按本 run 计划聚类的模型展示当前共享库中的组件与活跃类；点击类可查看定义、别名、首次出现和逐条出现样本（批次/case/证据引文/源文件位置），合并记录在模型列表中。样本列表按 case 分页。看板响应不设 CSP 和 X-Frame-Options，本机标注工具可以在页面内注入覆盖层；仅监听回环地址，不要绑定公网。刷新按钮会重新读取日期和运行状态；样本按 run 登记的 `input_id` 流式定位源记录，只取问题和最终回答，不加载原始消息链路；case 详情只显示一份问题；有标准答案时直接在问题下方展示，支持文本、数字及结构化答案，没有标准答案时不显示该区块；长文本原位展开与收起；「评测输入」按版本切换最终回答，默认收起。归因、对比分组列出源任务，改写进度计入运行总览；展开源任务即显示原始输出和已接受改写，按当前 Schema 标记字段，保留任务分析、判定、发现及其要求评估、问题定义和证据；发现与要求的索引从 0 开始，与结果中的引用一致。改写按槽位映射到对应原文字段：宽容器左右对照、窄容器上下排列，证据和判定保持原值；对比任务的盲测槽位由 Workflow 映射到实际模型。findings 顶部目录按优点 / 缺点分组，展示数量、原始索引、内容和重要性；findings 默认逐条收起，折叠行显示点评预览；点击目录自动展开目标条目，条目可返回目录，手动展开状态在页面刷新数据时保留。comparison 先显示裁决短评与逐项对照表，每行比较同一方面，每列对应同一模型，按重要性排列并标记本项优势；短评和比较格优先显示改写，原文原位折叠。裁决明细及 `evaluations` 的完整归因默认折叠，比较行的归因链接展开对应 finding；归因改写完成后也刷新 comparison 视图。失败或超时任务默认展开错误，其他任务默认收起；只有已接受任务读取正式结果，不为无结果任务展示空容器。字段标签与值在宽容器中对齐为两列，窄容器中上下排列；证据与长字段只保留一份正文并原位展开，阅读期间「收起」按钮保持在该段可视区域底部，从长文中部收起时回到该段预览；正式结果按任务读取，不加载整个 run 的结果文件，超长文本与证据引文按显示上限裁剪；运行总览的聚类详情按模型、批次与分片展示任务，展开后同时展示原始输出和改写后内容。高级设置和问题库均为可展开的折叠面板，问题库仅在展开面板时读取，已加载但暂无问题类时显示空状态；来源变化时显示当前记录或材料不可用。看板在有运行进行中或新进程等待登记时轮询刷新；新进程登记前每秒检查一次，登记后自动选中新运行，两分钟仍无状态则显示启动等待超时并停止等待。空闲或已结束的页面不再改 DOM，便于外部标注工具稳定选中内容。已接受结论始终来自正式结果 JSONL，不因来源变化而重评。输入可能包含敏感内容，仅在可信本机打开看板。

导航中的「数据与流程」（`/reference`）独立于运行页：输入区按日期和版本展示覆盖，并可搜索每个日期的 case / 批次、核对缺失版本、来源和对比组；流程区列出阶段依赖、产物、当前执行与聚类预算；定义区按 Agent 切换请求 / 提交 / 结果 Schema 和系统 / 任务提示词，并列出本阶段及提交工具的描述，以及无提交时追加的补交提示词；文案来自[集中提示词模块](../packages/prompts/README.md)。Schema 以字段树展示，完整 JSON 按需展开；内容直接读取当前应用使用的公开 Profile 和 Workflow Schema，不保存另一份契约副本，也不代表历史 run 的提示词快照。数据与流程页为只读视图。

「开始评测」选择本次运行的日期（数据源目录，默认全选；胶囊显示所选模型中至少一组可评测的 case 数/总数）、模型（默认全选，至少两个同组模型；全选不意味着把各组混排）和抽样数量（留空即全部）；运行 ID 由看板自动生成，不需要填写。日期选择会转换为已登记的 `batch_id` + case 过滤写入运行配置，评测契约仍以 `batch_id` 为准。预检不调用模型、不创建 run，确认后才启动；阶段模型从 `.env` 配置的网关 `/models` 列表读取，仅展示 `gpt` 系列，不能手填其他模型；推理等级、并发、超时、工具调用、传输重试预算、改写开关、聚类开关和 Debug 收在「高级设置」。设置不改写 `configs/host.json` 或本地模型文件；网关地址、密钥、输入和输出路径不在页面编辑，密钥值不会发送给浏览器。预检所用来源可能在启动前变化，启动时会重新读取。看板可以启动 Pi / Prime 运行、停止当前运行、动态调整并发，并从运行详情按钮续跑未完成任务；停止不会删除已接受结果。续跑沿用原批次、模型和抽样范围；已接受任务不重评，本次设置仅作用于未完成任务。停止和并发控制仍由 Host 持有运行锁令牌，看板只转发操作，不在页面暴露令牌。看板不提供远程认证，只监听本机回环地址，不应绑定到公网地址。

## 运行产物

所有交付文件位于 `data/runs/comparison/<run-id>/`，不生成 ZIP、tar 等压缩交付包。默认包含 `report.md`、`task_summaries.md`、`results/`、`state.json` 和 `stats.json`；运行中的 `.run-lock` 在退出时释放。

| 文件 | 用途 |
|---|---|
| `report.md` | 总览、分批样本、排名与对局矩阵、异常数量、用量缺失和校验状态；开启改写时优先展示润色文案 |
| `results/comparison.jsonl` | 每组的正式对比结果（排名、核心判定、裁决短评、逐项对照与派生两两判决），行内 `evaluator_version` 标识产出评测器；接受后追加并刷盘，运行中即可读取 |
| 源结果的 `rewritten` 字段 | 保存 `evaluator_version` 与 `rewrites` 槽位文本，原评测字段保留裁判原文；不单独生成改写文件或业务日志 |
| `results/attribution.jsonl` | 每条回答的归因判决与证据，行内 `evaluator_version` 标识产出评测器；按任务 ID 引用，成功提交后追加并刷盘；每条回答都会归因 |
| `results/clustering.jsonl` | 每个模型×批次分片的归类决定（观察、归类、新类与合并），行内 `evaluator_version` 标识产出评测器；run 结束应用进问题库 |
| `task_summaries.md` | 以 `batch_id / case_id` 标识逐题结论、同项对比、双方优缺点、原始回答耗时与 token 对照，以及失败、输入跳过原因和输入异常；开启改写时优先展示润色文案 |
| `state.json` | 唯一进度账本：任务与输入索引、批次范围、预检、当前 `evaluatorVersion` 与引擎身份、结果引用、待修草稿与错误、累计用量；已接受收据保留产出时的评测器版本与判官模型 ID（不保存连接配置）；候选信息仅登记一次 |
| `stats.json` | 数量、对局胜出、Token、缓存命中、耗时和校验汇总，以及 `evaluator_versions`、`judge_models`（按阶段列出去重的模型 ID）和 `artifacts` 产物清单；不包含逐题 ID 或异常明细 |

`stats.json` 保存 `standings`（每个版本参赛数、完成核心要求、首位、平均层、胜/都好/都差）、派生的 `head_to_head` 对局矩阵与 `per_version`；`by_batch` 按批次保存数量与对比口径，字段口径与总体统计一致；`problem_library` 按模型保存 `components`/`classes`/`occurrences` 与本 run 的 `assigned`/`proposed_new_classes`/`merged_classes`（后二者是接受的提议数与合并决定数，不是库文件的净增长）。`artifacts` 列出权威结果目录、结果文件、报告和状态文件。失败和待完成按任务计数，计划任务包含归因、对比，以及开启时的改写与聚类阶段；有效比较统计派生判决中的胜出、都好、都差。正式 JSONL 继续通过 `case.batch_id` 区分批次。Token、耗时和缓存统计保持全局口径。

`stats.json` 的 `tokens` 汇总所有已记录尝试，包含失败和重试；未取得最终用量的尝试计入 `attempts_without_final_metrics`，不能视作用量为零。`input` 为未命中缓存的输入，`cacheRead` / `cacheWrite` 为缓存读取/写入 Token，`output` 为输出，`totalTokens` 为总量。`cache.model_input.hit_rate` 是缓存读取 Token 占全部输入 Token（未缓存 + 读取 + 写入）的比例，无输入时为 `null`。不存在跨 run 结果缓存。

Pi / Prime 的 GPT-5.6、GPT-6 系列 Responses 评测请求使用固定 `prompt_cache_key=evaluation`，会话历史仍逐 attempt 隔离。没有材料工具、仅可提交结果的任务在首次请求使用无断点的显式模式，避免将一次性材料写入缓存；出现助手回复或工具调用历史后恢复隐式缓存，读取材料的多轮任务始终使用隐式缓存。其他模型、Chat Completions 和 Eris 会话保留 SDK 的缓存策略。此策略只修改请求缓存参数，不改提示词、材料、工具或推理参数，不更新 `evaluatorVersion`；网关须支持对应模型的 `prompt_cache_options`，实际收益以新增费用、`cacheWrite` 和完成量核对，命中率下降不一定代表费用增加。

`quality` 的首次通过率和修复次数按有内容提交计数的任务统计，包含归因、对比、改写和聚类阶段；无计数的任务不推算。`attempts_per_accepted_task` / `tokens_per_accepted_task` 是累计尝试数 / Token 除以已接受任务数。P50/P95 使用各任务已记录的累计 attempt 耗时，包含失败与重试，不是单次模型响应时间；`wall_seconds` 从首次启动计时，包含中途停机到续跑之间的间隔。

加 `--debug` 才会额外保留 `_internal/`。该设置写入 `state.json`，后续同 ID 继续运行时沿用；可以给已有普通运行加 `--debug`，此前未保存的日志不会补回。

| debug 文件 | 用途 |
|---|---|
| `_internal/contract.json`、`_internal/output_schema.json` | 各 Profile 的系统/任务提示词、工具描述、契约与 schema 快照；每次 attempt 的最终任务文本另见 `attempt.json` |
| `_internal/tasks/<id>/attempt-NNN/attempt.json` | 尝试的参数 `spec`、终态 `status`、最终用量与审计 `metrics`、失败原因及未接受的最后一次提交；未收齐的字段缺省 |
| `_internal/tasks/<id>/attempt-NNN/events.jsonl.gz` | 尝试的压缩执行日志 |
| `_internal/tasks/<id>/artifacts/` | 成功及失败尝试的脚本、stdout/stderr 和生成文件 |
| `_internal/diagnostics/` | 有记录才生成的 `failures.jsonl`、`skipped.jsonl` |
| `_internal/diagnostics/validation.json` | `validate` 发现正式结果错误时写出的校验详情；完整当次诊断也会输出到终端 |
| `_internal/exports/` | `report --details` 按需生成的 `task_summaries.jsonl`（含对应对比行的 `evaluator_version`）、`task_outcomes.jsonl`；后续重建报告时一并刷新 |

各阶段均在接受提交时先原子保存待落盘收据，再写入结果 JSONL 并刷盘；改写原子更新源结果行中的 `rewritten`，不追加独立行，随后将状态中的判决正文替换为结果引用。成功任务清除失败草稿和错误上下文，保留提交统计及重复错误计数。两次写入之间崩溃可从待落盘收据恢复；完成后正式 JSONL 是判决的唯一持久存储，不能删除它来清理空间。状态保留恢复原始提交所需的少量字段差异，以便同一提交 UUID 重发时确认内容一致。续跑可清除相同的重复行和中断尾行，冲突结果会报错；已压缩为引用的正式结果若丢失则明确报错，不自动重评。

并发状态保存共享等待中的下一次写入，只在实际写入开始时复制状态，避免磁盘繁忙时按并发数堆积完整状态副本；每个调用仍等待覆盖其变更的持久化写入完成。

检查点隔离复制可变进度和每条收据的索引外壳；已接受的判词、证据及正式结果正文保持不可变并共享引用，避免每次保存进度都深拷贝整批正文。结果写入器以替换导出引用的方式更新改写呈现，持久化完成后才回填当前收据。

`report` 按已接受收据重建结果 JSONL、Markdown 和统计，并使旧校验结果失效；已有结果引用可用于重建，无需重新读取输入。`validate` 分别报告正式结果、证据关系、交付覆盖及可选附件；计划中的对比未完成时，整体 `valid` 为 false，即使已有行的 `results.valid` 和 `evidence.valid` 为 true。附件未保存或缺失不撤销成功收据。普通模式切 debug 不补造历史附件或重评成功任务。原文件修改或删除后，旧结果保留，证据按业务标识定位：记录仍可找到则视为有效，找不到时报告材料不可用，不触发重评。两条命令不调用模型；`report --details` 仅用于 debug 运行，报告失败可独立重做。

最终验收应声明本轮要求，重复 `--require-batch` 检查实际批次集合，重复 `--require-rewrite` 检查偏好和逐项点评全覆盖：

```bash
npm run eval -- validate --run data/runs/comparison/daily-a \
  --require-batch <batch-id> --require-rewrite verdicts --require-rewrite items
```

`delivery` 输出分日期的计划、接受和满足改写要求的场数，及具体缺失槽位清单；同时检查业务键重复与未完成刷新，不能拿文件中的旧文案代替刷新成功。原字段/收据和重复/缺行由 `results` 核对，旧证据异常单列在 `evidence`。`--selected` 只将覆盖范围缩至当前固定清单对应的对比，用于试跑或定向修复；原字段、JSONL和证据仍检查该 run 的已有收据。四个日期分别执行上述验收，历史异常单独列明，不能将局部通过表述为全量通过。

输入只长期保留在原始数据源。`state.json` 保存源文件路径与行号供恢复和证据核对，不保存消息正文，也不计算内容哈希；项目校验限制见[开发指南](development.md#禁止项目哈希与兼容层)。Worker 工作区中的 `inputs/` 是执行期间的临时材料，完成后清除，不归档到 run。普通模式的 Worker 工作区临时存在，清理前保存最后草稿、错误与用量；debug 模式额外收集事件和产物，收集不完整时保留 Worker 副本。debug 事件运行中追加 `events.jsonl`，收集结束后压缩，崩溃时可能保留未压缩日志。

## 独立运行 Worker

默认由 Host 管理 Worker 进程。需要单独启动时：

```bash
npm run worker -- --engine pi --directory .runtime/workers/pi-1 --port 4101
npm run worker -- --engine prime --directory .runtime/workers/prime-1 --port 4102
npm run eval -- run --engine pi --worker http://127.0.0.1:4101 --run-id external-001 \
  --config configs/host.json --config configs/local/models.json
```

外部 Worker 由调用方管理，所有进程使用相同的模型 URL 和 key。任务开始前的健康检查最多等待10秒，避免短暂繁忙被误判为不可用；运行状态每秒查询一次，Worker 将连续事件合并写盘并保留完整有序回放，减少高并发 HTTP 和文件开关负载。停止信号会立即终止后续补位和依赖阻塞扫描。Worker 只监听回环地址，适用于可信单机调用。

代码工具工作目录不是安全沙箱；取消、超时和 Worker 退出会回收所属进程组。进程组信号被系统拒绝时，通过断开 IPC 请求调用守护进程回收，避免取消异常终止 Worker。需要隔离不可信代码时，应在受限部署环境运行整个系统。

## 独立评测分析 Agent

执行 `bash agent/run.sh` 自动打开对话；可用 `--port 4181 --user alice --no-open` 启动另一副本。Eris 浅色界面复用 Deepseek 源码，使用独立的 Eris Logo。配置、工具、用户归属与恢复规则见 [Agent 说明](../agent/README.md)。

### 重新改写对比文案

停止该 run 的活跃 Host 后，`rewrite-comparisons` 默认预览，`--apply` 才准备任务，然后用同一 run-id 续跑。默认 `--mode missing` 只补缺失槽位；`--mode refresh` 刷新已有文案，必须指定 `--task`、`--result` 或显式 `--all`。`--scope items`（默认）选择逐项点评，`--scope verdicts` 选择偏好理由；`--slot` 可重复，仅选择这些范围内的指定槽位。未知任务、结果或槽位会在任何状态变更前报错。也能为原来未开启改写的已接受对比创建改写任务。

```bash
# 预览全部缺失的逐项点评
npm run eval -- rewrite-comparisons --run data/runs/comparison/ID --scope items
# 只刷新一场的一格，其他格、偏好和判决保持原样
npm run eval -- rewrite-comparisons --run data/runs/comparison/ID --scope items \
  --mode refresh --result <comparison-id> --slot comparison.2.B.summary --apply
# 准备全部缺失偏好，或明确刷新全部偏好
npm run eval -- rewrite-comparisons --run data/runs/comparison/ID --scope verdicts --apply
npm run eval -- rewrite-comparisons --run data/runs/comparison/ID --scope verdicts --mode refresh --all --apply
```

应用后保存固定任务和槽位清单；应执行完这份清单后再准备下一份，新的应用会替换当前执行范围。已完成归因、对比及未选文案保留，选中改写任务的 attempts 累计。只提交请求中的槽位，回填合并到原 `rewritten`；没有匹配项时不修改状态。选择槽位的含义与[改写契约](contract.md#改写)一致。
