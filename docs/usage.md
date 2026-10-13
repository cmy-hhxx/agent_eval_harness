# 使用指南

[返回首页](../README.md) · 输入和结果语义见[数据契约](contract.md)；持续取数与上传见[自动化](automations.md)。

按顺序阅读：先完成[最短路径](#最短路径)，再按需查[输入治理](#输入治理)、[运行与恢复](#运行与恢复)、[运行产物](#运行产物)。自动化的状态与交付不属于本页的手动运行流程。

## 最短路径

1. 从 `config.example.ini` 创建 `config.ini`，填写渠道的 `base_url` 和 `api_key`。
2. 按[首页安装步骤](../README.md#最短运行路径)创建 `configs/local/models.json`，填写模型 ID。
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

评测和 Eris 共用根目录 `config.ini` 的渠道。每个 `[channel.<id>]` 定义独立地址、密钥和 API，渠道 ID 是稳定的路由身份；同名模型可同时存在于多个渠道。示例见 [config.example.ini](../config.example.ini)：

```ini
[channel.evaluation-gateway]
name = 评测网关
base_url = https://your-gateway.example/v1
api_key = your-gateway-key
api = openai-responses

[channel.openai]
name = OpenAI
base_url = https://api.openai.com/v1
api_key = your-openai-key
api = openai-responses
```

URL 保留渠道要求的路径。`api` 支持 `openai-responses`（缺省）和 `openai-completions`。渠道可填写默认 `model`、`thinking`、`context_window`、`max_output_tokens` 与 `supports_developer_role`；Eris 另可用逗号分隔的 `models` 限定开放模型、`efforts` 限定推理等级。渠道配置的模型必须存在于该渠道 `/models` 目录。重复 section、重复字段、无效 URL 与未知字段直接报错；支持整行 `#` / `;` 注释以及单引号或 JSON 双引号字符串，不支持行尾注释或变量插值。

`config.ini` 不入库；修改后重启服务。启动入口不再读取 `.env`。`[environment]` 保存搜索、MongoDB、S3 等非模型配置，读入服务端环境并传给子进程；同名值以 INI 为准。`[environment]` 可设置 `https_proxy`、`http_proxy` 与 `no_proxy`；使用代理时将 `localhost,127.0.0.1,::1` 加入 `no_proxy`，保证本机 Host / Worker 直连。自动拉起的 Pi / Prime Worker 继承渠道密钥和代理，独立 `npm run worker` 读取同一份 INI。测试或独立部署可用 `EVAL_CONFIG_FILE` 指向另一份 INI。Eris 初始模型和自动化连接字段分别见 [Agent 说明](../agent/README.md#模型与设置)与[自动化](automations.md#启动)。

JSON 配置用 `models.<profile>.channel` 引用渠道，例如 `"judge": { "channel": "evaluation-gateway", "model": "your-model-id" }`。阶段可同时覆盖渠道与模型：

```json
{"bindings":{"comparison":{"profile":"judge","channel":"openai","model":"your-openai-model-id"}}}
```

看板的阶段模型下拉框列出全部渠道，并随选择一起提交渠道 ID 和模型 ID。Eris 同样按渠道选择模型，常用列表使用渠道与模型的组合身份。自动化可通过 `[automation].channels` 指定优先顺序，额度耗尽时切换渠道，详见[自动化](automations.md#启动)。

模型与评测配置通过配置文件接口注入。`--config` 可重复，文件按出现顺序深度合并，相对路径按各自文件目录解析：

| 配置 | 含义 |
|---|---|
| `evaluatorVersion` | 评测器标识，必填非空字符串；写入每条正式结果的 `evaluator_version`，影响判词的变更必须更新它，详见[契约](contract.md#评测器版本标识) |
| `inputs.versions` | 版本 ID、展示名称、输入适配器与来源；ID 用小写字母开头的字母、数字和下划线，不能包含对局保留分隔符 `__vs__`；`comparison_tier` 可声明模型规模档位（默认 A/B 的 Fast 或 Expert）；`adapter` 引用已注册的输入结构，`sources` 用 `file`（单文件）或 `directory`（递归按 `include` 的 basename 匹配，缺省全部 `*.jsonl`）描述，可多个 |
| `inputs.timing_unit` | 原始耗时单位，`ms` 或 `s` |
| `comparisons` | 每组选择二至三个已登记模型，展开为独立两两比较；档位声明、缺失模型与重复模型对的规则见[对比组契约](contract.md#对比组) |
| `reviewQuestions` | 显式语义复核问题：`[{ batch_id, case_id, questions: ["待核问题"] }]`；精确匹配批次与 case，对该 case 当前所选各候选一视同仁。问题作为归因的待核材料，不是已确认事实或指定判词；无对应输入会在预检报告 `review_case_unavailable`。重评已接受但语义有误的结果时，使用限定 case 与模型对的新 run ID |
| `rewrite` | 文案改写：`{ comparison, attribution, clustering }`，三项默认开启，可显式设为 `false`；归因、对比及后置聚类接受后自动润色。对比默认润色偏好理由，`comparisonItems: true` 将逐项点评加入同一任务（自动化强制开启）；评测内改写写回源结果的 `rewritten` 字段，独立聚类作业保存单独的槽位结果；启用时必须有 `bindings.rewrite` |
| `models` | 命名模型档案：`channel`（引用 INI 渠道）、可选 `model` 和 `api`、`thinking`（模型档案缺省 `medium`，仓库 Attribution 绑定显式覆盖为 `high`；支持显式 `max`，Pi / Prime 原样传入，不降档）、`contextWindow`、`maxOutputTokens`（共享判官默认 32768，每次请求的思考与输出共用此预算）；可选 `supportsDeveloperRole` 声明网关能力，缺省保留现行行为，显式 `false` 时两种 API 将开发者角色作为系统角色发送，确保系统指令不被端点当作用户内容 |
| `bindings` | 评测阶段到模型档案的绑定，可按阶段覆盖 `channel`、`model`、`thinking`、`contextWindow`、`maxOutputTokens` |
| `execution` | 并发、超时、工具预算、修正和重试；仓库配置默认8并发，连续120秒没有模型/工具进展触发空闲超时，单任务总期限900秒 |
| `execution.failureGuard` | 同类失败熔断：`{ windowSize: 50, threshold: 5 }`；同阶段最近50个不同任务中，同类别、错误码与归一化字段路径达到5次时暂停该阶段；两者为整数，`windowSize >= threshold >= 2` |
| `output` | 运行产物目标：`{ kind: "directory", path }`；Host 在其下创建 `<run-id>` 子目录 |
| `problemLibrary` | 问题库目标：`{ kind: "directory", path }`；每个模型一份 `<version>.json`，跨 run 累积，只由聚类阶段写入 |
| `clustering` | 后置问题库上限与预算：`enabled`、`maxClassesPerModel`、`maxNewClassesPerTask`、`maxComponentsPerModel`、`consolidateAt`、`minSupport`、`maxCasesPerTask`；普通主线默认关闭，用 `cluster --run PATH ... --run-id ID --apply` 执行独立聚类作业；执行时必须有 `bindings.clustering` |

入库的 [configs/host.json](../configs/host.json) 只定义共享的输入、执行预算和模型档案骨架，不含具体模型 ID。具体模型放在不入库的本地配置：

```bash
mkdir -p configs/local
cp configs/models.example.json configs/local/models.json
# 编辑 configs/local/models.json，填入网关提供的模型 ID
npm run eval -- run --engine pi --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json
```

同一档案可被多个阶段复用，阶段差异只写在 `bindings`，不复制整段模型配置。`preflight`、`doctor`、`status`、`report` 不需要具体模型；只有 `run` 会解析全部绑定并要求模型 ID 与密钥齐全。`--input <版本 ID>=<路径>` 与 `--output <目录>` 可临时覆盖配置中的来源与目标。模型档案与解析见 [models.ts](../apps/host/src/models.ts)，评测配置见 [EvalConfig](../packages/workflows/src/comparison/types.ts)，输入/输出接口见 [InputSource / OutputTarget](../packages/contracts/src/index.ts)，运行目录布局见 [run-layout.ts](../packages/data/src/run-layout.ts)，通用预算默认值见 [DEFAULT_POLICY](../packages/contracts/src/index.ts)，加载与合并见 [loadConfig](../apps/host/src/config.ts)。

评审按每条回答的可见实际指令核查，并同时保存指令与交付证据；第三方未公开的系统保持未知。跨产品胜负依据共同用户任务和可验证交付，专有格式违规保留点评，不单独决定排名。注脚按来源编号映射完整材料，工具调用次数不作为编号上限；来源与渲染问题分别核查。归因复核以原始资料佐证事实，另一份回答的最终文本仅作核查线索；跨回答差异由对比阶段判断。当前材料与判决约束见[证据与导出](contract.md#证据与导出)。

## 目录约定

| 位置 | 内容 | 是否入库 |
|---|---|---|
| `configs/host.json` | 共享评测配置与模型档案骨架，路径相对于配置文件目录 | 是 |
| `configs/models.example.json` | 本地模型配置模板，复制为 `configs/local/models.json` 后填写模型 ID | 是 |
| `configs/local/` | 本机配置（如 `models.json`），可覆盖或补充共享配置；路径同样相对于配置文件目录 | 否 |
| `data/sources/<dataset>/<model>/<date>.jsonl` | 原始输入；当前回答数据集为 `model-answers`，每个模型一个目录、每个评测运行日一份文件 | 否 |
| `data/input-catalog/<dataset-id>/` | 本地评测集索引：`index.json` 汇总与逐行位置 JSONL，无原始消息 | 否 |
| `data/runs/<workflow>/<run-id>/` | 一次运行的状态、结果和报告；当前工作流为 `comparison` | 否 |
| `log/runtime.log`、`log/evaluation.log` | 共用的运行诊断日志和已接受评测日志 | 否 |
| `log/comparison-statistics-log.jsonl` | 自动化启用统计交付时的本地上传记录；见[自动化交付](automations.md#mongodb-增量交付与每四小时日志) | 否 |
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
    _daily/2026-09-22.json       # 如有：每日核对清单，不参与评测
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

共享问题库位于 `data/problems/<version>.json`，由已接受聚类收据更新；`report` 和 run 结束时幂等应用。归类、合并、主题、预算及统计语义统一见[问题库契约](contract.md#问题库与聚类)，准备命令见[后置聚类](#可选复核与后置聚类)。

### 历史问题样本的来源复核

原材料明确反证已有问题时，按 [occurrence-review Schema](../schemas/clustering/occurrence-review.schema.json) 准备决定文件：使用一次生成、重试复用的 UUID、模型 ID、库中的 occurrence ID、具体理由，以及原归因来源范围内真实工具返回的 text/json 证据。每项至少提供本方原材料证明。

```bash
npm run eval -- review-problem-occurrences --review-file /tmp/problem-review.json
npm run eval -- review-problem-occurrences --review-file /tmp/problem-review.json --apply
```

默认只读预览；`--apply` 在模型锁内追加撤销事件，更新问题库的有效样本投影。它不调用模型、不改原归因或历史结果，也不重写既有报告和统计日志。证据校验、幂等与合并后投影规则见[问题库契约](contract.md#问题库与聚类)。

新增评测日只需在对应模型目录放入 `YYYY-MM-DD.jsonl`（文件名用评测运行开始日），`sources` 直接指向模型目录，无需修改配置；跨天任务归开始日。批次身份取 JSON 中的 `batch_id`，目录和文件名只用于整理；用 `--batch` 按实际 `batch_id` 选择，`--input` 可把某个版本指向其他文件或目录。可选的 `_daily/<日期>.json` 清单记录该日的批次与各模型行数/case 数，只用于核对，不参与评测。`output.path` 指向工作流目录，Host 再创建 `<run-id>` 子目录。不同 run 隔离产物，同一 run 只有一个 Host 写入；原始输入不复制到 run。

续跑会重新读取原始记录，不因评测集索引或文件元数据变化而拒绝恢复。`state.json` 登记每个版本的来源路径与行号供恢复与证据核对；证据按业务标识（`batch_id + case_id + version`）定位，文件的追加或整理不影响已接受结果。未完成任务的来源缺失或无效时，该任务会被跳过并在预检诊断中报告，不中断整个 run。运行 ID、任务 ID、输入 ID 和盲测映射与目录无关。

运行规划和正式结果校验只在内存保留原始记录的字节位置，任务准备、提交校验和证据复核时再读取对应记录，不常驻整日回答正文。按记录读取仍检查文件修订和业务身份；启动后修改输入文件会中止受影响的读取，保存已接受结果后用同一 run 续跑即可读取新来源。

## 输入治理

日期文件和任务命名文件都可以登记为**评测集**；评测集 ID 是显式业务标识，不从目录或文件名推断。登记前先在 `inputs.versions` 注册被评模型（`id`、`name`、`adapter`），并在 `comparisons` 声明要比较的模型组合；手动 CLI 同 run 续跑不追加新版本。自动化可在既有日期 run 中补齐四模型，见[接管与更新](automations.md#历史接管与更新)。各模型的同一 case 必须提供相同的 `batch_id + case_id`，问题和标准答案也不能冲突；单纯同名文件不能替代记录身份。已选评测集中，若记录没有 `batch_id` 且未配置 `inputs.default_batch_id`，使用评测集 ID 作为该记录的默认批次；记录已有的批次不变，同一评测集仍可含多个显式批次。被评模型与 `bindings` 中的判官模型是两回事。

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

应用启动时创建项目根目录的 `log/`。运行/评测日志只使用下列两个 UTF-8 单行 JSON 文件，追加写入，不按日期或 run 分文件；自动化的统计交付另写 [`comparison-statistics-log.jsonl`](automations.md#mongodb-增量交付与每四小时日志)：

| 文件 | 写入内容 |
|---|---|
| `runtime.log` | 命令异常、预检或校验失败、失败尝试、任务终态异常，以及附件收集和 Worker 清理失败；自动化另记录[通道事件](automations.md#日志与进度)。包含时间、组件、事件、错误及可用的 run/task/attempt 标识；异常保留原始堆栈、cause 和附加属性。 |
| `evaluation.log` | 已通过校验并写入正式结果文件的评测输出。每行对应一份已接受收据，附运行、任务、阶段和提交标识，`result` 为 Workflow 规整后的结果。涵盖批量运行及独立专业任务的共同标准、归因、正式对比、待复核和聚类结果；改写不单独记录。 |

非错误事件按组件、事件、run、task、attempt 和消息在 60 秒内只保留首条；错误逐条保留，不合并或截断正文与堆栈。进度、心跳、模型流、工具调用和提交修复的中间反馈不写入运行日志；失败尝试即使随后恢复仍会记录。已配置的模型密钥会脱敏。

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

改写开关可以随续跑变化：开启后为已接受归因/对比补齐改写任务，关闭后不再计划未完成的对应任务；已接受收据和正式结果保留。聚类在全部归因结束后单独准备，见[可选复核与后置聚类](#可选复核与后置聚类)。

通过试跑或修复命令保存了 `executionScope` 时，续跑只执行清单内的任务，不重新发现输入，也不根据开关增加或删去任务；状态中的执行配置更新为本次实际预算，既有提交计数保留。只读取范围内未完成任务实际需要的源记录；纯改写无需原始输入。范围完成后仍保留清单；显式 `run --discover-inputs` 才恢复原选择范围内的输入发现和规划。此选项不会重评成功任务，也不会扩大原先的日期、case 或数量限制。

续跑沿用原运行的批次、case 和数量筛选条件，按 `batch_id + case_id + 阶段 + 版本组合` 识别归因与对比任务，改写任务保留原 UUID 与源任务引用，补缺和刷新按来源、范围及槽位清单复用未完成工作；本次传入的 `--batch`、`--case`、`--limit-cases` 不替换原范围。已经接受的归因、对比和改写结果不再评测，即使原输入、标准答案或模型参数发生变化。未完成任务使用最新有效输入，并加入原选择范围内的新增对比组；无效或冲突记录不能覆盖未完成任务，未完成任务的来源缺失或无效时使该任务跳过并记入预检诊断，不中断其他任务。需要新增日期批次或重新评测已完成样本时使用新 run ID。旧归因收据始终保留；未完成或新增对比仅在共同标准、标准答案一致且通过当前材料校验时复用它，否则创建独立归因复核。需要重做已经接受的判决时使用新 run ID。累计 attempts 和已记录的 Token 保留历次执行成本。运行退出码：0 成功、2 有失败、130 被中断。

内容修复、提交加载与传输错误使用独立预算。文件读取、JSON 解码和提交工具参数解析失败记入 `fileErrors`，单任务累计三次后停止，不挤占内容修正额度；必读材料不足时先补给真实原文页，也不消耗内容修正次数。单任务跨自动 attempt 和同 run 续跑共享 `1 + (execution.stageRepairAttempts[阶段] ?? execution.repairAttempts)` 次累计内容调用；可选核验的首查与最终确认共用该上限，恢复保留成功首查。Host 只派发剩余额度，耗尽时保存草稿、错误和计数，不调用模型；显式准备的新核验任务按 UUID 记录独立预算，已接受任务跳过。

默认 `execution.repairAttempts=3`，共同标准、每条回答的归因和最终对比各自最多返工3次，即各自最多提交4次（首稿 + 3次返工），不共用整条流程的总额度。其他阶段也沿用此默认值。可用 `execution.stageRepairAttempts` 显式覆盖对应阶段额度；同 run 只补足新增余额，不重置已用次数。归因与对比的结构反馈指向当前扁平提交字段；对比数量错误给出完整槽位顺序，归因还提供 `submission_shape`；模型按实际字段和槽位顺序修稿，程序不会把错误草稿静默改成结果。

内容失败最多自动开启一次跨 attempt 续修，带入最后草稿和结构化反馈；相同错误或实际改稿都不重置次数。代码、模型变化、重复准备和显式续跑不补发额度；提高该阶段实际生效的修稿额度时，只补足新上限与历史用量之差。源材料修订会清除失效草稿、证据目录、首查和材料反馈，但保留同 UUID 的历史提交、文件错误、用量及未知终态诊断。

无法确认 Worker 最终提交账本时，保存已确认计数、草稿与原因，停止本次自动重试。连接、流中断、HTTP/API 5xx，以及来自 SDK 助手错误事件的 server_error 或未携带状态码的明确服务内部错误，按 `execution.retries`、`execution.retryDelaySeconds` 有界退避；零提交、无可续修业务草稿的提前结束及空闲超时也使用该预算，日志保留中断分类和原始原因。模型在可修复的提交被拒后提前结束时，Worker 在同一会话补交提醒一次，携带具体错误与剩余额度，保留已读材料，避免直接重跑；内容、工具额度与总期限均不重置，耗尽或停止后不提醒。已有业务草稿按内容修复预算处理，相同报错不增加额度；主动取消和任务总期限超时不新增这些重试。

提交阶段、直接 JSON 与文件模式、写稿/必读/探索预算、SDK 参数和反馈校验细节统一见[提交方式与反馈](contract.md#提交方式与反馈)；传输、恢复和幂等规则见[HTTP 协议](architecture.md#http-协议)，工具计数见[工具架构](architecture.md#新工具)。

续跑只推进尚可完成的任务、不重试已有失败项时，给 `run` 添加 `--skip-failed`。已有失败、超时及依赖阻塞状态保留；已接受结果始终保留，未完成及新增任务继续按各自依赖推进。

### 只补失败与同类故障熔断

停止该 run 的 Host 后，先预览再应用：

```bash
npm run eval -- retry-failed --run data/runs/comparison/daily-a
npm run eval -- retry-failed --run data/runs/comparison/daily-a --task <task-uuid> --apply
npm run eval -- run --run-id daily-a --config configs/host.json --config configs/local/models.json
```

不指定 ID 时选择失败、超时、取消和阻塞任务；`--task`、`--result` 可重复，后者使用正式 `comparison_id`。必要的未完成依赖与下游一起进入固定清单；共享聚类分片的其他依赖未完成时，不自动把它及其他题目拉入局部补跑。已成功任务不加入补跑；选择已成功的对比时，可以补它尚未完成的改写。预览列出任务、原状态和累计 attempts；`--apply` 只准备状态并保留原内容提交及文件错误计数，随后同 run 续跑，不要求手改 `state.json`。其他未完成任务与后来追加数据不混入。零项选择不改状态。

评测 run 内的延期归类保留在 `results/clustering.jsonl`，不计作已归类或错误。`eval recluster --run PATH --task ID` 或显式 `--all` 预览可重归类观察；`--apply` 新建任务并固定范围，随后同 run-id 续跑。新任务只包含延期观察，使用当前问题库与剩余预算，保留原接受结果；重复准备复用未完成的重归类任务，保留该 UUID 的累计内容和文件错误计数，不补发额度。独立聚类作业保留所有已接受决定，包括延期；重新归类需创建新的作业 ID。

Host 按每阶段、不同任务维护最近结果窗口；同一题的反复尝试不重复计数。错误路径中的数组下标归一化为 `*`，类别、错误码或其他路径不同则分别统计。触发后保存 `pausedStages`（阶段、错误签名、样例 task ID 和时间），停止该阶段新派发和后续 attempt 重试；已派发的 attempt 完成清理，其他健康阶段继续。暂停状态跨重启保留，未到阈值的统计窗口属于本次 Host 会话。容量不足在创建 attempt 前处理，不计为题目内容失败。

先依据样例定位并修复原因，再显式解除相应阶段；不能用重启绕过熔断：

```bash
npm run eval -- run --run-id daily-a --resume-stage rewrite \
  --config configs/host.json --config configs/local/models.json
```

`--resume-stage` 可重复，只接受当前已暂停的阶段；它保留固定修复范围。日志统一写 `log/runtime.log`，进度输出 `stage_paused`；同错误签名是诊断线索，不证明所有样本同根因。暂停和失败会使 CLI 返回2。

持续运行的 [Automations](automations.md#调度与状态) 会核对检查点，自动恢复中断任务，并对传输、超时及响应流中断退避续跑；Worker 终态提交账本不可确认也进入该恢复流程，无需手动 `retry`。已接受收据、已确认内容提交和文件错误计数保留，不推测未确认用量；下一轮只使用当前上限扣除已知用量后的余额。结构、证据等持续校验错误仍保留保护性暂停。未完成任务的已确认内容提交达到当前配置累计上限时，该日期置为 blocked 并停止定时续跑，即使最后一次错误来自传输或中断；需调整累计上限或处理任务后再恢复，不因重启补满。

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

试跑并发取当前配置。运行中逐级增加，以每分钟**新增已落盘且满足本轮改写要求的对比**衡量净产出，同时观察返工、失败和写盘积压；Worker 数或阶段成功数不等于交付量。一次配置过高会使故障发现前已有较多任务在途。分层抽样只保证日期与模型组覆盖，不保证语义边界覆盖；[固定反例与语义放量门槛](quality.md#改写放量验收)仍须逐项核对。普通结构检查成功不会自动批准放量。

运行中可调整并发并查看进度：

```bash
npm run eval -- concurrency --run data/runs/comparison/pi-001 --value 8
npm run eval -- progress --run data/runs/comparison/pi-001
```

提高并发立即唤醒调度器并按需启动托管 Worker；降低并发停止补位，让健康任务自然完成。并发槽位或 Worker 已满时暂停材料组装，空出槽位后再为待执行任务准备材料。独立任务并行启动；提交及动态后续任务在持久化边界按序防重，避免回滚覆盖其他提交；等待写盘的状态变更合并为检查点，确认持久化后才返回成功。已持久化或尚未提交的任务可立即查询收据，不等待其他任务写盘；正在提交的收据仍须等自身持久化完成。外部 Worker 只调整使用数量。进度的 `concurrency` 是目标上限，`in_flight_tasks` 是 Host 实际占用槽位（包含提交、清理与 attempt 间等待），不等于 HTTP 请求数；`stages` 按阶段给出排队、依赖就绪、执行、接受和最近一分钟接受数，另有 `paused_stages` 与 `execution_scope_count`。至少五个耗时样本且无阶段暂停时才提供任务级 ETA；它不是完整对比交付的时间承诺。

### 本机运行看板

在项目根目录运行一条命令启动看板：

```bash
bash run.sh
```

首次启动会安装依赖并构建两套 SDK，之后每次重建 Host 和看板；默认使用 `configs/host.json`，若存在 `configs/local/models.json`，还会加载本地模型配置。默认监听 `127.0.0.1:4173`，按 `Ctrl+C` 停止。再次运行 `run.sh` 时，脚本先检查目标端口，仅停止当前仓库旧看板进程，等待退出后再构建并启动；不会停止评测 Host、Worker 或其他程序。其他程序占用端口时显示错误，可用 `--port` 指定不同端口。与 `agent/run.sh` 相同，正常启动只显示准备状态，准备失败输出完整错误并退出；`--debug` 显示安装与构建诊断，不传给 dashboard。端口等 dashboard 参数直接追加，例如 `bash run.sh --port 4181`；需要自定义配置文件时也可直接使用 `npm run eval -- dashboard --port <端口> --config <配置文件>`。

打开终端地址，从左侧选择运行，按 batch 和 case 查看输入、任务、正式结果与改写；布局和字段呈现统一见 [PRODUCT.md](../PRODUCT.md)。

新建评测：

1. 选择日期、模型和抽样数量；默认 10 个样本，“全部”或留空表示全部。`Seed` 默认 41，可设为 0–4294967295 的整数；相同候选范围、数量和 Seed 产生相同抽样，留空则随机，选全部时不使用 Seed。模型按配置中的同档对比组规划。
2. 在高级设置调整阶段模型、推理等级、并发、预算、改写和 Debug。模型来自网关 `/models`，默认值来自合并配置；页面不编辑密钥、网关或输入输出路径。
3. 输入数量扫描完成后先预检，再确认启动。预检不调用模型、不创建 run；改变设置须重新预检。启动复用选中 case，由 CLI 重新校验来源、模型、密钥与运行锁。

运行中可停止或调整并发；详情可续跑未完成任务，保留原批次、模型、抽样范围与已接受结果。日期盘点和预检复用内存中的轻量来源索引，实际执行与续跑不使用它替代原始材料。运行中或等待新 run 登记时自动刷新，空闲时停止轮询；等待登记超过两分钟显示超时。

| 页面 | 内容与读取边界 |
|---|---|
| 运行工作台 | 主线任务及归因补查；输入按登记引用只读原问、最终回答和标准答案，结果展开时按任务读取正式 JSONL。聚类在运行总览查看；可选核验通过独立结果文件查看 |
| 问题库 `/problems` | 按模型、组件、问题类及主题查看共享库，分页读取出现样本并召回原 run、case 与 finding；不写问题库 |
| 数据与流程 `/reference` | 输入覆盖、阶段依赖、当前 Profile 的 Schema、提示词与工具说明；展示当前构建，不是历史 run 的契约快照 |

删除运行需在页面确认，删除范围包括该 run 的状态、结果、报告、统计、Debug 材料及两份运行日志中匹配该 run ID 的记录。运行中、未释放或损坏的锁、损坏日志均阻止删除。原始输入、其他运行、共享问题库和聚合交付回执保留；删除不可恢复。

## 可选复核与后置聚类

普通运行完成共同标准、各回答归因、必要时最多一轮定向归因补查和每场一次对比，并默认自动润色归因与正式对比文案。需要独立检查已接受的正式对比时，先预览，再准备核验：

```bash
npm run eval -- verify-comparisons --run data/runs/comparison/pi-001
npm run eval -- verify-comparisons --run data/runs/comparison/pi-001 --apply
npm run eval -- run --engine pi --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json
```

`--result <comparison_id>` 可选择特定正式对比。不带 `--apply` 只读预览；准备后保存仅包含核验任务的执行范围，后续同 run 运行调用模型。核验复用已接受主线收据，结果写 `results/comparison-verification.jsonl`，不替换归因或正式对比，不自动扩展复核链。核验失败、疑点或未完成都不影响原正式结果的统计、改写与交付。

所选 run 的归因结束后，一次选择一个或多个 run，按模型汇总多个日期的问题：

```bash
# 默认只读预览，不调用模型、不保存作业
npm run eval -- cluster \
  --run data/runs/comparison/daily-2026-10-08 \
  --run data/runs/comparison/daily-2026-10-09 --run-id october-problems

# 加 --apply 直接创建并执行独立作业
npm run eval -- cluster \
  --run data/runs/comparison/daily-2026-10-08 \
  --run data/runs/comparison/daily-2026-10-09 --run-id october-problems \
  --config configs/host.json --config configs/local/models.json --apply

# 中断后沿用固定来源和已接受结果；无需再次指定 --run
npm run eval -- cluster --run-id october-problems \
  --config configs/host.json --config configs/local/models.json --apply

# 查看已保存进度，不执行
npm run eval -- cluster --run-id october-problems
```

默认产物在评测输出根目录旁的 `data/runs/clustering/<run-id>/`，可用 `--output DIR` 指定聚类作业根目录；续跑须使用同一目录。`state.json` 保存来源引用、任务与进度，`results/clustering.jsonl` 保存归类决定及来源坐标，`results/rewrite.jsonl` 保存聚类文案的槽位改写，`stats.json` 和 `report.md` 保存进度与问题库统计。聚类改写默认开启，可在首次创建时设 `rewrite.clustering=false`。原评测 run 的状态、正式结果和上传回执保持原样。

有主线归因或必要补查仍 pending/running 时拒绝启动；失败归因跳过并计数，选定范围内成功且有正式收据的归因参与。聚类不等待对比、改写或可选核验。来源重复题选择、跨日期汇总、分片与末尾目录整理规则见[问题库契约](contract.md#问题库与聚类)。续跑固定来源和任务范围，已接受任务不重做；新增日期用新的作业 ID。更换模型、参数或评测器不拒绝续跑，旧收据保留原评测器标识。保护性阶段暂停修复后可用 `--resume-stage clustering` 或 `--resume-stage rewrite` 解除。原始回答文件离线不阻止聚类，但原 run 的状态和正式归因结果必须可读且引用一致；显式样本来源复核仍需原始材料。

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

应用后保存固定任务和槽位清单；应执行完这份清单后再准备下一份，新的应用会替换当前执行范围。已完成归因、对比及未选文案保留。已接受的局部改写补缺或刷新另建 UUID，并保留原任务和收据；相同来源、范围和槽位的未完成工作复用原 UUID，attempts、内容提交和文件错误计数累计。开启完整改写后自动补缺遵循同一规则。只提交请求中的槽位，回填合并到原 `rewritten`，同一槽位采用最新接受的文本；没有匹配项时不修改状态。选择槽位的含义与[改写契约](contract.md#改写)一致。

## 运行产物

所有交付文件位于 `data/runs/comparison/<run-id>/`，不生成 ZIP、tar 等压缩交付包。默认包含 `report.md`、`task_summaries.md`、`results/`、`state.json`、`overview.json` 和 `stats.json`；运行中的 `.run-lock` 在退出时释放。

| 文件 | 用途 |
|---|---|
| `report.md` | 总览、分批样本、排名与对局矩阵、异常数量、用量缺失和校验状态；开启改写时优先展示润色文案 |
| `results/criteria.jsonl` | 同题共同验收标准，从题目、已有标准答案、上下文与指令原文生成；归因和裁决镜像同一份标准 |
| `results/comparison-review.jsonl` | 主线中来源核心未知或材料存在已知冲突的待核结果，不计对战判决；不自动重新归因 |
| `results/comparison-verification.jsonl` | 显式准备的独立核验记录；成功、疑点与主线结果分开保存，不改写正式胜负、不阻塞交付 |
| `results/comparison.jsonl` | 每场两两正式对比结果（排名、核心判定、裁决短评、逐项对照与派生两两判决），行内 `evaluator_version` 标识产出评测器；接受后追加并刷盘，运行中即可读取 |
| 源结果的 `rewritten` 字段 | 保存 `evaluator_version` 与 `rewrites` 槽位文本，原评测字段保留裁判原文；不单独生成改写文件或业务日志 |
| `results/attribution.jsonl` | 每条回答的归因判决与证据，行内 `evaluator_version` 标识产出评测器；按任务 ID 引用，成功提交后追加并刷盘；每条回答都会归因 |
| `results/clustering.jsonl` | 每个模型×批次分片的归类决定（观察、归类/延期、新类、合并与目录维护），行内 `evaluator_version` 标识产出评测器；run 结束应用进问题库 |
| `task_summaries.md` | 以 `batch_id / case_id` 标识逐题结论、同项对比、双方优缺点、原始回答耗时与 token 对照，以及失败原因与错误码、输入跳过原因和输入异常；开启改写时优先展示润色文案 |
| `state.json` | 唯一进度账本：任务与输入索引、批次范围、预检、当前 `evaluatorVersion` 与引擎身份、结果引用、待修草稿与错误、累计用量；已接受收据保留产出时的评测器版本与判官模型 ID（不保存连接配置）；候选信息仅登记一次 |
| `overview.json` | 随状态保存更新的轻量运行目录索引，仅保存进度计数和状态文件元数据；Eris 无需扫描历史状态正文，校验与显式重建见 [Eris 本地运行与结果](../agent/README.md#本地运行与结果) |
| `stats.json` | 数量、对局胜出、Token、缓存命中、耗时和校验汇总，以及 `evaluator_versions`、`judge_models`（按阶段列出去重的模型 ID）和 `artifacts` 产物清单；不包含回答正文，来源冲突单列 `statistical_diagnostics`，标准冲突单列 `standard_conflicts` |

`stats.json` 保存 `standings`（每个版本对局数、核心可判题数、完成核心要求、核心待定题数、胜/都好/都差，以及核心样本覆盖和冲突计数）、派生的 `head_to_head` 对局矩阵与 `per_version`；`coverage` 记录计划、已决、待核和未完成的正式比较数，`standard_conflicts` 列出已标记标准冲突的归因，供人工复核；`by_batch` 按批次保存数量与对比口径，字段口径与总体统计一致；`problem_library` 按模型保存 `components`/`classes`/`occurrences` 与本 run 的 `assigned`/`proposed_new_classes`/`merged_classes`（后二者是接受的提议数与合并决定数，不是库文件的净增长）。`artifacts` 列出权威结果目录、结果文件、报告和状态文件。报告与看板的失败只计 `failed`、`timed_out`；`blocked` 单列为依赖阻塞，`cancelled` 单列为取消，待完成计 `pending`、`running`，原始任务状态保持不变。各项均按任务计数，计划任务包含共同标准、归因、对比，以及显式开启的核验、改写和聚类阶段；有效比较统计派生判决中的胜出、都好、都差。正式 JSONL 继续通过 `case.batch_id` 区分批次。Token、耗时和缓存统计保持全局口径。

正确性和核心完成情况按 `batch_id + case_id + version` 去重；同一回答参加多场对战或保留多条复核归因时，只计一次。正确性优先采用正式对比引用的归因来源；没有正式对比时，只采用唯一的当前输入来源，来源缺失、来源不唯一或结论冲突均计为未确定，冲突另计 `conflicted_count` 并写入 `statistical_diagnostics`。核心通过率的分母是结论明确的去重样本数，`core_decidable_coverage` 表示这部分样本占所有核心样本的比例；跨对战的核心结论冲突计入 `core_conflicted_count` 和未确定数。`standings.entered`、胜率及 `head_to_head` 仍按实际对战场数计数。上述报告字段不改变冻结的统计上传日志结构。

`stats.json` 的 `tokens` 汇总所有已记录尝试，包含失败和重试；未取得最终用量的尝试计入 `attempts_without_final_metrics`，不能视作用量为零。`input` 为未命中缓存的输入，`cacheRead` / `cacheWrite` 为缓存读取/写入 Token，`output` 为输出，`totalTokens` 为总量。`cache.model_input.hit_rate` 是缓存读取 Token 占全部输入 Token（未缓存 + 读取 + 写入）的比例，无输入时为 `null`。不存在跨 run 结果缓存。

只有 INI 渠道显式配置 `supports_explicit_prompt_caching=true` 时，Pi / Prime 的 GPT-5.6、GPT-6 系列 Responses 评测请求才启用缓存扩展，并使用固定 `prompt_cache_key=evaluation`，会话历史仍逐 attempt 隔离。没有材料工具、仅可提交结果的任务在首次请求仅为固定系统提示词设置显式断点，避免将一次性材料写入缓存；出现助手回复或工具调用历史后恢复隐式缓存，读取材料的多轮任务始终使用隐式缓存。未声明该能力的渠道、其他模型、Chat Completions 和 Eris 会话保留 SDK 的缓存策略；模型名相同不代表不同渠道支持相同扩展。此策略只修改请求缓存参数，不改提示词、材料、工具或推理参数，不更新 `evaluatorVersion`；网关须支持对应模型的 `prompt_cache_options`，实际收益以新增费用、`cacheWrite` 和完成量核对，命中率下降不一定代表费用增加。

`quality` 的首次通过率和修复次数按有内容提交计数的任务统计，包含共同标准、归因、对比、改写和聚类五个阶段；无计数的任务不推算。`attempts_per_accepted_task` / `tokens_per_accepted_task` 是累计尝试数 / Token 除以已接受任务数。P50/P95 使用各任务已记录的累计 attempt 耗时，包含失败与重试，不是单次模型响应时间；`wall_seconds` 从首次启动计时，包含中途停机到续跑之间的间隔。

加 `--debug` 才会额外保留 `_internal/`。该设置写入 `state.json`，后续同 ID 继续运行时沿用；可以给已有普通运行加 `--debug`，此前未保存的日志不会补回。
调试事件只有在本机逐条写入到 Worker 公开的终态 `lastSeq` 且读到 `finished` 后才压缩归档并释放 Worker 副本。终态后的等待使用已有 `idleTimeoutSeconds`，每条成功写入重置无进展期限；尾部缺失或断连未恢复会记录 `event_archive_incomplete`、标记材料缺失，并保留未完成的 `events.jsonl` 与 Worker 原件。已接受判词保留，不为调试档案重新评测。

| debug 文件 | 用途 |
|---|---|
| `_internal/contract.json`、`_internal/output_schema.json` | 各 Profile 的系统/任务提示词、工具描述、契约与 schema 快照；每次 attempt 的最终任务文本另见 `attempt.json` |
| `_internal/tasks/<id>/attempt-NNN/attempt.json` | 尝试的参数 `spec`、终态 `status`、最终用量与审计 `metrics`、失败原因及未接受的最后一次提交；未收齐的字段缺省 |
| `_internal/tasks/<id>/attempt-NNN/events.jsonl.gz` | 尝试的压缩执行日志；Pi Responses 的终态工具参数保留原字符串，用于区分网关参数错误与 SDK 解析错误 |
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

`delivery` 按主线正式对比节点输出分日期的计划、接受和满足改写要求的场数，及具体缺失槽位清单；同时检查业务键重复与未完成刷新，不能拿文件中的旧文案代替刷新成功。原字段/收据和重复/缺行由 `results` 核对，旧证据异常单列在 `evidence`。`--selected` 只将覆盖范围缩至当前固定清单对应的对比，用于试跑或定向修复；原字段、JSONL和证据仍检查该 run 的已有收据。按本轮实际日期逐一执行上述验收，历史异常单独列明，不能将局部通过表述为全量通过。

输入只长期保留在原始数据源。`state.json` 保存源文件路径与行号供恢复和证据核对，不保存消息正文，也不计算内容哈希；项目校验限制见[开发指南](development.md#禁止项目哈希与兼容层)。Worker 工作区中的 `inputs/` 是执行期间的临时材料，完成后清除，不归档到 run。普通模式的 Worker 工作区临时存在，清理前保存最后草稿、错误与用量；debug 模式额外收集事件和产物，收集不完整时保留 Worker 副本。debug 事件运行中追加 `events.jsonl`，收集结束后压缩，崩溃时可能保留未压缩日志。

## 独立运行 Worker

默认由 Host 管理 Worker 进程。需要单独启动时：

```bash
npm run worker -- --engine pi --directory .runtime/workers/pi-1 --port 4101
npm run worker -- --engine prime --directory .runtime/workers/prime-1 --port 4102
npm run eval -- run --engine pi --worker http://127.0.0.1:4101 --run-id external-001 \
  --config configs/host.json --config configs/local/models.json
```

外部 Worker 由调用方管理，所有进程使用相同的模型 URL 和 key。任务开始前的健康检查最多等待10秒，避免短暂繁忙被误判为不可用；运行状态在观察到进展时快速复查，安静时回退到每秒一次，Worker 将连续事件合并写盘并保留完整有序回放，减少高并发 HTTP 和文件开关负载。停止信号会立即终止后续补位和依赖阻塞扫描。Worker 只监听回环地址，适用于可信单机调用。

代码工具工作目录不是安全沙箱；取消、超时和 Worker 退出会回收所属进程组。进程组信号被系统拒绝时，通过断开 IPC 请求调用守护进程回收，避免取消异常终止 Worker。需要隔离不可信代码时，应在受限部署环境运行整个系统。

## 独立评测分析 Agent

执行 `bash agent/run.sh` 自动打开对话；可用 `--port 4181 --user alice --no-open` 启动另一副本。Eris 浅色界面复用 Deepseek 源码，使用独立的 Eris Logo。配置、工具、用户归属与恢复规则见 [Agent 说明](../agent/README.md)。
