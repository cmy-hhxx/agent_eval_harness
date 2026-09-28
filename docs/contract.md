# 数据与评测契约

[返回首页](../README.md) · 文件位置与命令见[使用指南](usage.md)。

## 唯一规则来源

- 输入与分组：[input.ts](../packages/workflows/src/comparison/input.ts)。
- 所有内置 Agent 提示词、材料边界与工具描述：[提示词模块](../packages/prompts/README.md)；各阶段规则在 `packages/prompts/resources/<stage>/default/`。
- Comparison 的[公开入口](../packages/agents/src/comparison/index.ts)与[业务校验](../packages/agents/src/comparison/validate.ts)；对比只引用归因 finding，不做证据展开。Attribution 的[归因 Profile](../packages/agents/src/attribution/index.ts)独立维护单条回答的归因契约，只输出问题描述。Clustering 的[公开入口](../packages/agents/src/clustering/index.ts)与[问题库](../packages/agents/src/clustering/library.ts)拥有归类、新建与合并。Rewrite 的[公开入口](../packages/agents/src/rewrite/index.ts)只交换文本槽位，不接触证据。
- 全部 Schema：[根目录 schemas 模块](../schemas/README.md)。其中有[Attribution schemas](../schemas/attribution/)、[Comparison schemas](../schemas/comparison/)、[Rewrite schemas](../schemas/rewrite/)、[Clustering schemas](../schemas/clustering/)和[Workflow schemas](../schemas/workflow/)。
- 正式导出组装：[schema.ts](../packages/workflows/src/comparison/schema.ts)。
- 导出与工具回溯：[report.ts](../packages/workflows/src/comparison/report.ts)、[annotations.ts](../packages/workflows/src/comparison/annotations.ts)。

项目处于快速迭代阶段，状态、结果 Schema、Profile 和内部协议不设置版本号；当前源码定义唯一契约。唯一例外是 `evaluatorVersion`：顶层配置显式声明、人工维护的评测器标识，用于区分不同版本评测器产出的判词，不是 Schema 或协议版本。影响判词的变更（提示词、业务校验、材料组装、证据解析、判决与导出逻辑、聚类硬约束）必须同步更新它；引擎构建身份由 `state.json` 的 `engine` 单独记录。

### 评测器版本标识

- `configs/host.json` 顶层 `evaluatorVersion` 必填非空字符串，`loadConfig` 校验；续跑时以本次配置为准，不因版本变化拒绝续跑。
- `state.json` 的 manifest 保存当前 `evaluatorVersion`；每个已接受收据保留产出时的版本和解析后的判官模型 ID `judge`（不保存模型连接配置）。同 run 可以混合版本：已接受收据和已落盘行不变，未完成任务使用当前版本。读取正式结果时须核对行内版本与收据版本一致。
- 四种正式结果行顶层都带 `evaluator_version`，取自该任务收据；`report` / `validate` 按收据重建，不重新解释版本。显式导出的逐题总结 JSONL 沿用对应对比行的版本。
- `stats.json` 的 `evaluator_versions` 汇总本 run 已接受版本，`judge_models` 按阶段列出实际使用的模型 ID。

## Agent 先记

- 原始 JSONL 没有统一总 Schema；适配器和预检负责来源解析与业务校验。
- `request` 是 Host 组装的内部材料，`submission` 是模型提交，`result` 是 Host 接受后的结果。
- 契约变更直接更新当前调用方，不保留旧入口、别名、迁移层或静默降级。
- 不新增没有必要的哈希、摘要或跨 run 结果缓存；使用业务 ID、UUID 以及结构和引用校验。

细节按“输入 → 阶段输出 → 对比判决 → 证据导出”顺序阅读。

## 输入与输出的分层

这里的“输入”有两层，不能与 Agent 的输出混为一个 Schema：

1. **原始评测输入**：来源文件中的 JSONL。它允许由 `a` / `aa` 适配器接入不同结构，不维护一个覆盖所有来源的总 JSON Schema；[input.ts](../packages/workflows/src/comparison/input.ts) 和适配器负责预检、归一化与业务校验。
2. **Agent 请求材料**：Host 为某个阶段拼出的 `ground_truth`、`library`、`candidates` 和依赖结果。根目录 `schemas/<stage>/request.schema.json` 只是 Host 到 Agent 的内部装配护栏，不是数据源契约；如果请求字段变化，同步修改 `workflow.ts` 和对应 Profile。

阶段输出则分为两种：

- `submission.schema.json`：模型通过提交工具返回的 JSON。证据使用 attempt 内的 `evidence_id`；Attribution 还必须为每个 finding 提供本条回答内唯一的 `finding_id`，不提交可从请求推导的 `has_standard_answer`。
- `result.schema.json`：Host 展开证据并接受后的阶段结果。证据变为 `message_index + quote`，finding_id 保留以维护问题库的样本血缘。

各阶段的 Agent 输出契约如下：

| 阶段 | 一次处理 | 输出内容 | 下游用途 |
|---|---|---|---|
| Attribution | 一条已标明版本的回答 | 条件性的 `is_correct`、`correctness_reason` / `correctness_evidence`、`task_analysis`、`summary`、有证据的优点及确定/疑似问题 `findings`；Host 在接受结果时加入 `has_standard_answer` | 写入 `attribution.jsonl`；Comparison 读取去身份视图，Clustering 读取问题观察并维护问题库 |
| Comparison | 一个对比组 | `task_analysis`、分层 `ranking`、每个候选的 `assessments.meets_core/summary`、`decision_basis.tradeoff/decisive_findings` | Workflow 恢复盲测标签、生成 `comparison.jsonl` 和派生 `verdicts` |
| Rewrite | 一个归因、对比或聚类结果 | 与请求 `items` 一一对应的 `rewrites`（相同 id、润色后的文本），不含判定、证据或新增条目 | 写入源结果的 `rewritten` 字段；报告与逐题总结优先展示改写文案 |
| Clustering | 一个模型 × 一个批次（可按 case 分片） | `assignments` 把每个观察归入已有类或新类，`new_classes`（key/component/label/definition/最接近类/novelty），可选 `merges` | 写入 `clustering.jsonl`；run 结束把决定写进该模型问题库 |

Attribution 需要 evidence resolution，保留 submission/result 两份 Schema。Attribution、Comparison、Clustering 的结果 Schema 均声明可选 `rewritten`；Comparison 与 Clustering 的提交 Schema 由公开入口从结果 Schema 去掉该字段，原 Agent 不提交改写内容。Rewrite 提交与结果共用其 `result.schema.json`。Workflow 的 export Schema 不是任一 Agent 的输出 Schema，只描述加入身份、模型信息、归因评语、回溯标注和派生判决后的正式对比行；改写槽位由三个阶段各自的 `result.schema.json` 描述，聚类导出由 `schemas/workflow/clustering.schema.json` 描述。分析助手的工具输入见 [eris/tools.json](../schemas/eris/tools.json)，它不是评测提交 Schema。

## 输入

日常回答存于 `data/sources/model-answers/<模型>/<运行开始日>.jsonl`，每个模型一个目录、每个评测运行日一份日期文件；跨天任务的文件名取运行开始日，另有 `_daily/<日期>.json` 清单记录批次与各模型行数/case 数。任务命名文件也可放在模型目录中；无论文件名如何，每行代表一份「批次 × case × 版本」回答。[host.json](../configs/host.json) 为每个版本配置 `sources`：`file` 直接读取一个文件，`directory` 递归读取（缺省全部 `*.jsonl`）。目录和文件名只用于整理，不参与批次或版本识别，也不要求文件名等于版本 ID。

任务命名文件可使用 `竞品对比.jsonl` 等任意文件名，每个版本文件可以包含多个批次。显式登记的评测集 ID 用于选择一组来源文件；已有 `batch_id` 以原始记录为准，两者均不从文件名推断。评测直接使用提供的 `batch_id` 原值，不要求日期格式，也不从 `request_time` 或 `ask_time` 重新分组；按 `--dataset` 选择时，缺失批次且未配置全局默认批次的记录以该评测集 ID 作为默认 `batch_id`。样本身份为 `batch_id + case_id`：同问句跨批次或在同批次对应不同 case 时分别保留，不按问句文本去重。

| 字段 | 语义 |
|---|---|
| `batch_id` | 优先顶层，其次 `meta.batch_id`，最后配置的 `inputs.default_batch_id` |
| `case_id` | 优先顶层，其次 `meta.case_id`；两处都有时必须一致 |
| `version` | 文件配置决定版本；记录若含该字段，必须与配置 `name` 一致 |
| `request_time` | 缺失或 null 合法；非空字符串原样保留；空字符串和其他类型在预检拒绝 |
| `has_standard_answer` | 可选布尔值，其他类型拒绝；显式为 `false` 时忽略本条记录的 `meta.ground_truth` / `meta.std_answer`；是否有对错判定由样本共享标准答案决定 |
| `messages` | 完整问题、回答、工具与图片；消息序号是证据定位依据 |
| `meta` | 采集状态、标准答案、被评模型、原始回答耗时等 |
| `trace_id` | 原始追踪标识 |

`meta.ok=false`、无完整最终回答、无法解析或未知消息类型的记录不能参与比较。标准答案从 `meta.ground_truth` / `meta.std_answer` 获取；排除被显式忽略、缺失、null 和空字符串的值后，剩余值需要一致。同批次、同 case 的有效版本共享标准答案：只要其中一份提供了标准答案，所有参与对比的版本都会归因，并在共享标准答案存在时判对，包括本条 `has_standard_answer=false` 的版本；仅写 `true` 而不提供标准答案时归因仍会运行，只是 `is_correct=null`。

输入结构通过适配器注册表声明。当前注册 `a`（OpenAI 风格 `messages`：`message` / `reasoning` / `function_call` / `function_call_output`）和 `aa`（显式轮次：`user_question` / `llm_turn` / `tool_call` / `tool_result` / `final_answer`），版本配置的 `adapter` 按 id 引用。新增结构只需实现 [InputAdapter](../packages/workflows/src/comparison/adapters.ts) 并在注册表登记，`adapt` 与配置校验不再分支。适配器保持原始消息和多模态内容，不重排消息序号，不补造缺失回答。每个 `batch_id + case_id + version` 对应一份回答；相同标识出现多份回答时报告标识冲突，使涉及它的对比组失效，不擅自选择或覆盖。同批次、同 case 的问题或标准答案冲突会使该样本失效；不同批次分别检查，允许标准答案不同。

不按文件行号分组。本地评测集索引记录来源文件与行字节范围，只存业务标识和定位坐标，不存完整消息或问题/标准答案；预检和评测仍重新校验原始记录。登记、选择、索引存储及无效记录处理见[输入治理](usage.md#输入治理)。实际记录数、缺失版本、对比组数和跳过原因通过 `preflight` 获取。`by_batch` 按批次汇总样本数、有效回答数、归因任务数、对比任务数、跳过对比组数和输入异常数。样本数包含已识别身份但回答无效的样本；异常和跳过记录保留批次、case 及已定位输入的文件和行号，无法识别批次的异常只计入全局诊断。文档不保存随数据变化的批次统计。

## 对比组

参与对比的版本组合由配置的 `comparisons` 声明，每项是一组已登记版本；组内所有版本在同一次判断中比较。版本的可选 `comparison_tier` 声明模型规模档位：同一组不能出现不同档位，不能让 A组Fast 与 A组Expert 排名。默认是 `[a_fast, aa_fast]`、`[a_expert, aa_expert]` 两个独立对比组。DeepSeek、Kimi 等可登记为未标档位的第三方基线，分别加入 Fast、Expert 组（如 `[a_fast, aa_fast, deepseek]` 与 `[a_expert, aa_expert, kimi]`）；若第三方也标档位，则必须与组内一致。档位按配置声明，不从版本名、适配器或真实模型 ID 猜测。每个批次内的 case 对每组生成一个对比任务；组内缺少任一有效版本则跳过该组。选多个组不会合并排名；续跑以当前对比组规划未完成任务，既有已接受结果仍保留。结果写入 `results/comparison.jsonl`。

盲测标签 A、B、C… 仅属于 Comparison，按组首次随机分配并持久化，不代表实际版本或模型身份；导出时恢复稳定版本 ID。归因任务使用单数 `answer` 并可见真实版本身份。进入 Comparison 前，Workflow 对题目、标准答案、原始耗时字段、归因文本和工具可读取的 trace 使用同一份去身份视图；原始来源、归因正式结果和证据不因此改写。可区分的版本、展示名和回答模型标识在文本及结构化字段名中会遮蔽；图片字节保持原样供工具查看。单字符或与业务正文混淆的简称，以及仅隐含在正文中的身份，仍需人工检查盲测要求。组内候选的导出顺序与候选位置不影响派生判决。

## 归因与判决

每条回答先经过归因 Agent：以 Workflow 的 `ground_truth.available` 为准，有标准答案时必须判 `is_correct`（true/false）并给出最终回答证据，无则输出 `is_correct=null`、`correctness_reason=""` 和空对错证据；`has_standard_answer` 由 Host 从请求填入接受结果。无论有无标准答案，都产出该回答的 `task_analysis`、`summary` 与 `findings`。`scoring_points` / `red_flags` 没有实际内容时为空，finding 无对应核心要求时 `requirement_index=null`。有证据的优点用 strength；确定或疑似问题用 problem，并以 `assessment.evidence_status` 区分已确认与待核实，不能把疑似写成确定错误。每个问题只描述问题观察：`problem.component` 必须是该回答实际工具调用或结果中确切的工具名（与材料 `catalog.name` 一致），模型误读工具结果或自行推理/表达的问题用「模型自身推理」，不得使用能力/阶段名；`problem.label` 与 `problem.definition` 给出可复用的现象及边界。工具名表示问题发生部位，不表示工具提供方有责任。归因不读问题库、不指定分类、不建类。

对比 Agent 读取该组各候选的归因结果以及原始 trace/回复，对归因 findings 再做一次核验，输出统一 `task_analysis`、分层排名 `ranking` 和每个候选的 `meets_core`；默认归因结论正确，只做确认与核验，不新建 finding。

Agent 自主决定读取、检索、图片观察和计算步骤。提示词要求数值争议核算，但程序不强制调用某个计算工具或按固定顺序操作。通过 `submit_evaluation` 直接提交，或用 `submit_evaluation_file` 提交工作目录内的 JSON 文件；两者使用同一套内容校验，并共享提交修正预算。拒绝时保存 `evaluation-draft.json`，反馈包含 `code/path/message` 及适用的 `candidate/expected/actual`，可用工具获取证据 ID 后修正草稿；每次允许的修正保留一次额外材料或代码工具调用。证据坐标解析失败时，`message` 给出该消息的可用路径或长度供重新检索。模型整回合没有提交且没有报错时，Worker 用集中提示词追加一次提交提示，仍无提交才记为失败。Host 保存有效收据后才算完成；未接受时退出、超时或模型报错保留失败状态。

两两判决由排名与核心判定派生，不单独判定：

| 情况 | 派生判决 |
|---|---|
| X 完成核心要求、Y 未完成 | 判 X 胜 |
| 双方都未完成核心要求 | `both_bad` |
| 双方都完成、排名同层 | `both_good` |
| 双方都完成、排名不同层 | 层更靠前者胜 |

`ranking` 是标签按层的二维数组，最优层在前、同层并列，每个候选恰好出现一次。`task_analysis.requirements` 只列核心验收要求，额外加分项放 `scoring_points`。`meets_core=false` 表示未交付全部核心要求；`high`/`medium`/`low` 描述优势或缺陷对核心任务的影响程度。

有标准答案时，归因 `is_correct=false` 的候选不得判为 `meets_core=true`。Host 在接收提交、恢复和离线校验时检查排名是候选的划分、`assessments` 覆盖全部候选、决定性发现引用既有归因 finding；这些检查只保证结构与引用关系，不能代替事实和影响判断。

提交包含 `task_analysis`、`ranking`、`assessments` 与 `decision_basis`。`decisive_findings` 用 `candidate` + `finding_index` 引用归因 findings，只引用实际影响排名的发现；`tradeoff` 按同一比较方面逐段对照全部候选，再解释相邻层差异与同层并列理由；共同优点不能写成独有优势，缺少同名 finding 不代表另一方没有该能力。内容质量和回答体验都要对照，质量相当时明显的等待或资源差异可以影响排名，速度不能抵消核心错误。对比阶段不提交 evidence、不新增 finding。

## 问题库与聚类

问题库是每个模型一份的跨 run 知识库（`data/problems/<version>.json`），只有聚类阶段能写入。每条已接受聚类决定记录：`assignments` 把每个观察（按 `component + label` 归一化聚合的同一问题）归入已有类或新类，`new_classes` 声明新类的 `component/label/definition` 以及最接近的已有类和 novelty 理由，`merges` 把同一组件下的近义旧类合并到保留类。疑似和已确认观察都交给聚类；类别按现象复用，不为确定程度另建类。聚类请求给出两种出现次数及示例的 `evidence_status`，库中每个出现样本保留自己的 `evidence_status`，不将疑似样本冒充为已确认。相同问题名可分别属于不同工具组件；观察只可归入同一组件内的类（已有组件的别名等同于该组件）。写库顺序是先合并、再建类、最后落出现样本；每个出现样本保留 `class_id`、`evaluator_version`（归类收据的版本；原归因版本见归因结果行）、`batch_id`/`case_id`/`version`/`input_id`/`run_id`/`task_id`/`submission_id`/`finding_id`、消息位置、原文与源文件行号，可从问题类反查到样本、再回到原始数据；合并保留 `previous_class_id` 与 `class_merged`/`occurrence_moved` 事件，被合并类的 label 与 aliases 追加到目标类。入库按 `(class_id, input_id, finding_id)` 幂等，重复 report 或续跑不会重复计样本。

数量由程序硬控，提示词只做引导：

- 计划期把该模型本 run 的 `maxClassesPerModel − 活跃类数` 和 `maxComponentsPerModel − 活跃组件数` 分别均摊到全部分片；绑定任务时按该分片实际观察到的未知组件数收窄 `max_new_components`，不得突破预留份额；
- 提交必须覆盖全部观察且只归一次，`class_id` 必须是库中活跃类，新类必须被至少一个观察使用且覆盖样本数达到 `minSupport`；
- 同一组件内，`新类 label` 归一化后命中活跃类 label 或 alias 时直接拒绝，要求复用该 `class_id`；
- `活跃类 − merges + new ≤ maxClassesPerModel`；新组件只能来自本任务观察到的组件，并受 `maxComponentsPerModel` 限制；
- 活跃类达到 `consolidateAt` 时提示 Agent 检查同组件近义类并输出 `merges`；合并不增加当前任务的 `max_new_classes`，腾出的预算在后续 run 规划时重算。
- 写库按模型锁住读、合并、校验和保存；不同 run 共享同一模型时不会互相覆盖。所有模型的上限校验通过后才写文件；若有模型超出 `maxClassesPerModel` 或 `maxComponentsPerModel`（例如并发 run 或手工下调上限），本次报告不写入任何模型的库，并提示调高上限。

聚类任务失败时库保持不变，当天问题仍保留在 `attribution.jsonl`。

## 改写

改写阶段可选（配置 `rewrite.attribution` / `rewrite.comparison` / `rewrite.clustering`），把已接受的归因、对比或聚类结论润色为更简洁规整的表达。每个源结果对应一个改写任务：对比组写 `assessments[].summary`、`decision_basis.tradeoff` 和派生 `verdicts[].reason`；归因写 `summary`、非空的 `correctness_reason`、finding 的 `text/reason` 与 `assessment.observation/impact`；聚类写新类的 `definition/novelty` 和 `merges[].reason`，无新类和合并时返回空改写。

- 对比裁判继续盲测；Workflow 在改写前将槽位称谓还原为真实组别与模型名称（如 A组Fast、AA组Fast），槽位 id 不变。
- 输入是 Workflow 选定的文本槽位（`items[].id/label/text`）及 case 的批次/case ID 或聚类的批次/模型定位信息，不含原题、原始消息、证据和 finding 引文；模型看不到可用来重新判断的材料，只能润色。
- 提交必须与请求一一对应：相同 id、相同数量，不新增、不遗漏、不重复；真实组别与模型称谓、事实相关的数字与单位、限制条件和不确定性原样保留；裁判无关的自评打分/置信度分档可以删除，不拿用户指令充当具体优点。
- 正式结果不变：`attribution.jsonl`、`comparison.jsonl` 保留裁判被接受时的原文；`ranking`、`meets_core`、`is_correct` 和证据不因改写变化。改写附在对应阶段结果的 `rewritten` 字段：归因为 `evaluation.rewritten`，对比为 `rewritten`，聚类为 `result.rewritten`（内容为 `evaluator_version` 与 `rewrites` 槽位文本），不单独生成结果文件或业务日志。
- 看板同时展示原始输出和改写后内容，聚类详情在运行总览。问题库的类身份、归属与原始定义不被改写覆盖。
- `report.md` 与 `task_summaries.md` 优先展示改写文案，离线校验仍以正式结果收据为准。
- 续跑可以开启或关闭改写：已接受的改写保留，未完成且被关闭的改写任务不再计划；已接受的评测结果不受影响。

## 证据与导出

对比结果 JSONL 和逐题总结 JSONL 的每行都以 `request_time`、`has_standard_answer` 两个顶层字段开头，其后是产出该行的 `evaluator_version`。`request_time` 取该组第一个版本（按 `comparisons` 声明顺序）的输入原值，缺失时为 `null`，不受盲测标签影响；`has_standard_answer` 为布尔值，表示本题是否有有效标准答案、是否进入归因的对错判定，与 `ground_truth.available` 一致。

内部提交使用工具或初始材料提供的 `evidence_id`，绑定消息、来源路径和原文位置；程序展开为正式结果的 `message_index + quote`。ID 是明文坐标：`ev_<消息索引>_<text|json>_<起>_<止>_<路径>`，图片为 `ev_<消息索引>_image`；模型逐字复制，Host 按坐标重新定位来源。索引、路径或起止范围无效时拒绝，不会从错误坐标猜测引文或把越界范围改成整段；反馈提供来源长度、可用路径，模型应重新读取工具返回的 ID。读取、搜索和展开共享公共工具包中的字符串/JSON 表示，不进行其他模糊匹配。可引用消息内的原始字符串，也可引用该消息按两空格缩进显示的 JSON 连续片段，包括结构化工具返回的字段和数值；`search_trace` 同样支持查找这些片段。图片提交使用图片 evidence ID 与 `observation`，正式结果展开为 `[图像观察]`，工具审计必须存在实际 `view_image` 记录。Host 校验引用、索引和判决关系，事实判断仍需[质量复核](quality.md)。

初始材料是渐进式披露的首屏：只展示 `initialContextChars` 预算内的投影消息，投影会剔除 `input_messages`、`model`、`model_parameters` 等内部字段，证据引文同样计入预算；完整消息和隐藏字段通过材料工具按需读取，工具结果按 `maxOutputChars` 截断并可将完整内容存为可分页产物。

每条对比行给出 `ranking`、`assessments` 与派生的 `verdicts`（键为组内稳定版本对）。派生判决使用 `win` / `both_good` / `both_bad`，后两种的赢家字段为 `null`；`verdicts[].reason` 是程序生成的规则概述，逐题的具体差异与反向事实在 `decision_basis.tradeoff`、候选评估和归因 findings 中。评语中的 `【候选A】`、`候选A` 等会按盲测映射替换为展示名称；A股、A+H、A浪、方案A等题目术语与证据原文保持不变。汇总分别统计各版本胜出数、都好数和都差数，三类互斥且相加等于有效比较数，失败不计入上述分类。

归因任务使用单份 `answer`，对错证据必须来自其 `final_message_index` 对应的最终回答，不能引用问题、标准答案、工具结果或中间推理（findings 证据可引用该回答的调用链）。正式归因行包含 `task_id`、`submission_id`、`input_id`、`case`、稳定 `version` 和 `evaluation`（判对结论、理由、展开的原文证据）；评语不做盲测标签替换。结果文件位置与恢复规则见[运行产物](usage.md#运行产物)。

`stage` 表示发现属于上下文回溯、推理、执行或最终回答；`stage_trace` 由程序从原始消息生成，包含工具、位置、置信度与来源。只回溯当前 finding 引用的证据；无法唯一定位时保留候选工具，不猜测确定来源。

Comparison 请求的 `original_answer_timing` 包含首 token、首段回答与完成耗时，统一为秒；`original_answer_usage` 从被评输入 `meta.usage` 提取输入、输出、总 token 和缓存输入，记录来源字段、总量依据及数据异常。A 的 `input_tokens_details.cached_tokens` 和 AA 的 `cached_read_tokens` 统一为 `cached_input_tokens`，它是输入子集，不重复累加；未记录总量且输入、输出都有效时才相加。缺失或无效指标为 `null`，总量冲突与缓存超出输入会标记异常，不使用裁判 SDK 消耗或累加 trace 快照。对比结论在 `decision_basis.tradeoff` 中引用实际比较的数值与差异，报告沿用已接受结论，不重读来源来重评。

逐题总结包含问题、要求、判决、同项对比理由、各方优缺点、得分点、red flags 和原始回答体验对照。逐项使用可比数据，未知指标不填零；token 量不等于价格，单次耗时不代表长期性能。
