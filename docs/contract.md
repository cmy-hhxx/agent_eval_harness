# 数据与评测契约

[返回首页](../README.md) · 文件位置与命令见[使用指南](usage.md)。

## 唯一规则来源

- 输入与分组：[input.ts](../packages/workflows/src/comparison/input.ts)。
- 所有内置 Agent 提示词、材料边界与工具描述：[提示词模块](../packages/prompts/README.md)；各阶段规则在 `packages/prompts/resources/<stage>/default/`。
- Criteria 的[公开入口](../packages/agents/src/criteria/index.ts)固定共同验收基准。Comparison 的[公开入口](../packages/agents/src/comparison/index.ts)与[业务校验](../packages/agents/src/comparison/validate.ts)；对比只确认既有归因，不做证据展开。Attribution 的[归因 Profile](../packages/agents/src/attribution/index.ts)独立维护单条回答的逐项事实、核心判定、优点及问题描述。Clustering 的[公开入口](../packages/agents/src/clustering/index.ts)与[问题库](../packages/agents/src/clustering/library.ts)拥有归类、新建与合并。Rewrite 的[公开入口](../packages/agents/src/rewrite/index.ts)只交换文本槽位，不接触证据。
- 全部 Schema：[根目录 schemas 模块](../schemas/README.md)。其中有[Criteria schemas](../schemas/criteria/)、[Attribution schemas](../schemas/attribution/)、[Comparison schemas](../schemas/comparison/)、[Rewrite schemas](../schemas/rewrite/)、[Clustering schemas](../schemas/clustering/)和[Workflow schemas](../schemas/workflow/)。
- 正式导出组装：[schema.ts](../packages/workflows/src/comparison/schema.ts)。
- 导出与工具回溯：[report.ts](../packages/workflows/src/comparison/report.ts)、[annotations.ts](../packages/workflows/src/comparison/annotations.ts)。

项目处于快速迭代阶段，状态、结果 Schema、Profile 和内部协议不设置版本号；当前源码定义唯一契约。唯一例外是 `evaluatorVersion`：顶层配置显式声明、人工维护的评测器标识，用于区分不同版本评测器产出的判词，不是 Schema 或协议版本。影响判词的变更（提示词、业务校验、材料组装、证据解析、判决与导出逻辑、聚类硬约束）必须同步更新它；引擎构建身份由 `state.json` 的 `engine` 单独记录。

### 评测器版本标识

- `configs/host.json` 顶层 `evaluatorVersion` 必填非空字符串，`loadConfig` 校验；续跑时以本次配置为准，不因版本变化拒绝续跑。
- `state.json` 的 manifest 保存当前 `evaluatorVersion`；每个已接受收据保留产出时的版本和解析后的判官模型 ID `judge`（不保存模型连接配置）。同 run 可以混合版本：已接受收据和已落盘行不变，未完成任务使用当前版本。读取正式结果时须核对行内版本与收据版本一致。
- 共同标准、归因、对比、对比复核请求及聚类的 JSONL 行顶层带 `evaluator_version`，取自源任务收据；改写不单独成行，内嵌 `rewritten.evaluator_version` 取自改写收据。`report` / `validate` 按收据重建，不重新解释版本。显式导出的逐题总结 JSONL 沿用对应对比行的版本。
- `stats.json` 的 `evaluator_versions` 汇总本 run 已接受版本，`judge_models` 按阶段列出实际使用的模型 ID。

## Agent 先记

- 原始 JSONL 没有统一总 Schema；适配器和预检负责来源解析与业务校验。
- `request` 是 Host 组装的内部材料，`submission` 是模型提交，`result` 是 Host 接受后的结果。
- 契约变更直接更新当前调用方，不保留旧入口、别名、迁移层或静默降级。
- 不新增没有必要的哈希、摘要或跨 run 结果缓存；使用业务 ID、UUID 以及结构和引用校验。

细节按“输入 → 阶段输出 → 对比判决 → 证据导出”顺序阅读。

## 输入与输出的分层

这里的“输入”有两层，不能与 Agent 的输出混为一个 Schema：

1. **原始评测输入**：来源文件中的 JSONL。它允许由 `a` / `b` 适配器接入不同结构，不维护一个覆盖所有来源的总 JSON Schema；[input.ts](../packages/workflows/src/comparison/input.ts) 和适配器负责预检、归一化与业务校验。
2. **Agent 请求材料**：Host 为某个阶段拼出的 `ground_truth`、`library`、`candidates` 和依赖结果。根目录 `schemas/<stage>/request.schema.json` 只是 Host 到 Agent 的内部装配护栏，不是数据源契约；如果请求字段变化，同步修改[材料映射](../packages/workflows/src/comparison/binding.ts)和对应 Profile。Workflow 可通过 `AgentBinding.modelInput` 显式提供模型展示投影；Host 只用它渲染提示词，Schema、证据展开和业务校验始终使用内部 `request`。

阶段输出则分为两种：

- `submission.schema.json`：模型通过提交工具返回的 JSON。Attribution 模型的证据使用本 task 内从 1 开始的 `reference.evidence_index`；Host 在结构化选择后恢复完整坐标再做业务校验，按最终展开位置生成本条回答内唯一的 `finding_id`，模型不提交该字段；不提交可从请求推导的 `has_standard_answer/task_analysis`。无标准答案时也不提交三个对错字段，程序生成正式空值；有标准答案时三个字段均必需。Profile 可按可信请求提供模型展示用 Schema，实际提交仍经过本地结构和业务校验。Comparison 同样不提交共同 `task_analysis`，也不提交自己的证据；核心状态、失败判据以及比较格 status/evidence_status 由程序从既有归因派生，提交只保留同序固定槽的点评、importance、better_candidate、一次 preference 和 tradeoff；关联、覆盖与排名由程序派生。
- `result.schema.json`：Host 展开证据并接受后的阶段结果。证据保留程序生成的必填 `evidence_id + message_index + quote`，finding_id 保留以维护问题库的样本血缘。

各阶段的 Agent 输出契约如下：

| 阶段 | 一次处理 | 输出内容 | 下游用途 |
|---|---|---|---|
| Criteria | 同题、同标准的一组候选约束 | 从本轮问题、已有标准答案与候选用户上下文的原文目录选择来源；形成带 ID、`applies_to` 和 `acceptance_rule` 的 `task_analysis`，不向模型展示 SYS/DEV、回答或工具轨迹 | 写入 `criteria.jsonl`，作为归因与对比的共同基准 |
| Attribution | 一条已标明版本的回答 | 条件性的 `is_correct`、`correctness_reason` / `correctness_evidence`、`criterion_assessments`、`core_assessment`、`summary`、有证据的优点及确定/疑似问题 `findings`；Host 在接受结果时加入 `has_standard_answer` | 写入 `attribution.jsonl`；Comparison 读取去身份视图，Clustering 读取问题观察并维护问题库 |
| Comparison | 两个候选 | `status`、复核请求、分层 `ranking`、核心分类、带 criterion ID / 状态 / 证据状态的逐项对照及决定依据 | decided 写入 `comparison.jsonl`；needs_review 写入 `comparison-review.jsonl`，不派生判决 |
| Rewrite | 一个归因、对比或聚类结果 | 与请求 `items` 一一对应的 `rewrites`（相同 id、润色后的文本），不含判定、证据或新增条目 | 写入源结果的 `rewritten` 字段；报告与逐题总结优先展示改写文案 |
| Clustering | 一个模型 × 一个批次（可按 case 分片） | `assignments` 把每个观察归入已有类或新类，`new_classes`（key/component/label/definition/最接近类/novelty），可选 `merges` | 写入 `clustering.jsonl`；run 结束把决定写进该模型问题库 |

Criteria 解析来源短编号、Attribution 展开证据引用、Comparison 区分正式决定与最小复核请求、Clustering 解析请求内短编号，分别保留 submission/result 两份 Schema。Attribution、Comparison、Clustering 的结果 Schema 均声明可选 `rewritten`，原 Agent 不提交改写内容。Rewrite 提交与结果共用其 `result.schema.json`。Workflow 的 export Schema 不是任一 Agent 的输出 Schema，只描述加入身份、模型信息、归因评语、回溯标注和派生判决后的正式对比行；改写槽位由三个阶段各自的 `result.schema.json` 描述，聚类导出由 `schemas/workflow/clustering.schema.json` 描述。分析助手的工具输入见 [eris/tools.json](../schemas/eris/tools.json)，它不是评测提交 Schema。

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

`meta.ok=false`、无完整最终回答、无法解析或未知消息类型的记录不能参与比较。标准答案从 `meta.ground_truth` / `meta.std_answer` 获取；排除被显式忽略、缺失、null 和空字符串的值后，剩余值需要一致。同批次、同 case 的有效版本共享标准答案：只要其中一份提供了标准答案，所有参与对比的版本都会归因，并在共享标准答案存在时核对其一致性，包括本条 `has_standard_answer=false` 的版本；仅写 `true` 而不提供标准答案时归因仍会运行，只是 `is_correct=null`。

输入结构通过适配器注册表声明。当前注册 `a`（OpenAI 风格 `messages`：`message` / `reasoning` / `function_call` / `function_call_output`）和 `b`（显式轮次：`user_question` / `llm_turn` / `tool_call` / `tool_result` / `final_answer`），版本配置的 `adapter` 按 id 引用。新增结构只需实现 [InputAdapter](../packages/workflows/src/comparison/adapters.ts) 并在注册表登记，`adapt` 与配置校验不再分支。适配器保持原始消息和多模态内容，不重排消息序号，不补造缺失回答。每个 `batch_id + case_id + version` 对应一份回答；相同标识出现多份回答时报告标识冲突，使涉及它的对比组失效，不擅自选择或覆盖。同批次、同 case 的问题或标准答案冲突会使受影响模型对失效；不同批次分别检查，允许标准答案不同。

不按文件行号分组。本地评测集索引记录来源文件与行字节范围，只存业务标识和定位坐标，不存完整消息或问题/标准答案；预检和评测仍重新校验原始记录。登记、选择、索引存储及无效记录处理见[输入治理](usage.md#输入治理)。实际记录数、缺失版本、对比组数和跳过原因通过 `preflight` 获取。`by_batch` 按批次汇总样本数、有效回答数、归因任务数、对比任务数、跳过对比组数和输入异常数。样本数包含已识别身份但回答无效的样本；异常和跳过记录保留批次、case 及已定位输入的文件和行号，无法识别批次的异常只计入全局诊断。文档不保存随数据变化的批次统计。

## 对比组

`comparisons` 每项选择两个或三个已登记模型。三模型展开为三场独立两两比较；重复模型对只执行一次。某个模型缺失或冲突只跳过受影响的对局，仍执行有效模型对。两两任务各自随机并持久化 A/B 位置，不把一次三方排名拆成三个独立观测。可登记更多模型，再选择不同的二至三模型组；没有四方同场排名。

默认 Fast、Expert 分别比较。三模型组必须全部显式声明相同的 `comparison_tier`；两模型组只要有一方声明档位，另一方也必须声明相同档位。仅双方都未声明档位的两模型组可不设置该字段；第三方基线加入已分类组时须声明其实际档位，不能绕过公平性检查。配置保留用户选择的组，Workflow 执行时展开模型对。

同批次、case、同问题和标准下先固定共同 Criteria；一致标准可从一份输入传播，互斥标准分别规划，不让同一回答随对手切换标准。归因只有在 Criteria、标准答案一致且按当前材料通过归因校验时才复用；不一致时独立复核。候选约束集合改变需重新准备共同基准，旧接受结果及其血缘保留。

每场独立两两 Comparison 首次随机分配并持久化 A/B 位置，不代表实际版本或模型身份；导出时恢复稳定版本 ID。归因任务使用单数 `answer` 并可见真实版本身份。进入 Comparison 前，Workflow 对题目、标准答案、共同 `task_analysis`、源归因中的同一分析、原始耗时字段、归因文本和工具可读取的 trace 使用同一份去身份视图；原始来源、Criteria 收据、归因正式结果和证据不因此改写。可区分的版本、展示名和回答模型标识在文本及结构化字段名中会遮蔽；图片字节保持原样供工具查看。单字符或与业务正文混淆的简称，以及仅隐含在正文中的身份，仍需人工检查盲测要求。候选的导出顺序与候选位置不影响派生判决。

## 归因与判决

每条回答先经过归因 Agent，以 Workflow 的 `ground_truth.available` 为准。有标准答案且能够核实时，`is_correct` 为 true/false；确实无法核实时可为 null，但 `core_assessment.meets_core` 必须同时为 null，并引用适用 requirement 的 unknown/uncertain 评审，交独立复核。两种情况都须填写非空核对理由和最终回答证据；已确认的缺失、数值不等价或量纲冲突不能改成未知。无标准答案时，模型省略 `is_correct/correctness_reason/correctness_evidence`，即使提交 null、空字符串或空数组也拒绝；程序生成正式结果中的 `is_correct=null`、`correctness_reason=""` 和空对错证据，模型仍提交 `numeric_checks=[]`。`has_standard_answer` 由 Host 从请求填入接受结果。模型工具 Schema 从可信请求选择，不采用展示投影决定这些字段。归因提交安全检查可识别字段中的覆盖、作用域、无标准答案、问题描述约束及当前证据数组中的引用坐标，与结构错误一并反馈；结构错误或缺项不会遮蔽已能解析的非法引用。合并后的反馈仅按完整错误内容去重；不同候选、判据、路径或修复细节分别保留。接受结果继续使用同一套独立规则和完整证据校验。

无论有无标准答案，都产出 `criterion_assessments`、`core_assessment`、`summary` 与 `findings`。`task_analysis` 由 Host 镜像共同 Criteria，模型不能重新提交或改写。模型在 `core_assessment` 中只提交 `requirement_indices`，使用本方目录展示的原 requirements 全局零起始索引；程序绑定正式 `criterion_ids`，不改变 `meets_core/reason` 的模型判断。过滤后的材料位置不重新编号，scoring_points、red_flags、越界或他方不适用要求不能作核心依据；反馈只给当前可选数字索引。`scoring_points` / `red_flags` 没有实际内容时为空，finding 无对应核心要求时 `requirement_index=null`。有证据的优点用 strength；确定或疑似问题用 problem，并以 `assessment.evidence_status` 区分已确认与待核实，不能把疑似写成确定错误。模型提交 `type=strength` 时省略 `problem` 字段，程序在正式结果中生成 `problem=null`；提交任何该字段值都会被拒绝。`type=problem` 必须提交包含 `model_responsible`、`tool_evidence_indices`、`label`、`definition` 的 `problem` 对象，不提交 `component` 或工具名称。`model_responsible` 显式声明有证据支持的模型责任；`tool_evidence_indices` 选择本条 finding 原提交 evidence 数组的零起始位置，不是材料目录的 `reference.evidence_index`。程序在规范扩展、追加和本方/peer 重排前按原位绑定责任证据，仅接受本方真实工具调用或返回，从可信 `catalog.name` 生成并去重正式 `problem.component`；模型责任为 true 时加入「模型自身推理」。未选作责任的工具引用不自动生成组件。`reason/definition` 逐个解释责任：工具正确执行错误参数、或模型误读正确返回时归模型；工具自身返回有缺陷且实际传入错误结论时归工具；双方均有独立证据才共同列入。工具参与调用不等于有责任，无返回也不等于提供了错误值；需要继续追查最终数字的真实来源。每个工具责任位置必须指向它自己的调用或返回证据；越界、最终回答、规范、用户或 peer 证据不能生成本方工具责任，错误反馈只提供本 finding 实际可选的位置，未知上游原因保留不确定性。材料目录按调用 ID 补全返回消息的工具名和 `call_message_index`，不按相邻位置猜测；`problem.label/definition` 给出可复用的现象及边界。同一问题跨多个组件仍是一条 finding；Workflow 按组件展开聚类 observation，各组件类分别关联同一个 finding_id，不增加回答缺点数。责任未查明时提交 `model_responsible=false`、`tool_evidence_indices=[]`，正式结果生成 `component=[]`，definition 保留实际工具来源与待查原因，看板显示“待定位”；已确认的结果偏差仍可保持 established。被评模型不可见标准答案，不能以未核对标准值归责模型。未定位组件的 finding 保留在归因和对比中，暂不进入按组件组织的问题库。归因不读问题库、不指定分类、不建类。对比漏项反馈给出具体候选、零起始 finding 索引和原文，修复时在对应候选的 finding_indices 中补齐关联。

Criteria 模型只提交完整原文段落的 source_indices 数字选择，不手写来源标识或判据 ID，不提交自由改写的要求或验收规则。程序在归并后按组生成连续 r1/f1/s1 判据 ID，以及 goal、task_type、原文 text、作用域与固定 acceptance_rule；问题和存在的标准答案各自必须至少被一条适用于全部候选的 requirement 选中，多条私有条款的作用域并集不算公共覆盖。可与真正共同适用的来源合并，整条作用域仍须覆盖全部候选。分组不改变原文的条件、例外或否定效力。程序先校验原始选择的来源编号、作用域、数量和必选源公共覆盖，再归并完全相同来源集合或完全相同的原文、作用域与验收规则，优先保留 requirements、red_flags、scoring_points，同组保留第一条；原始提交不修改，不按近似含义归并不同内容或作用域。正式结果继续检查重复条款，不能直接提交重复结果绕过组装。每条 criterion 有稳定 ID、要求文本、候选 input UUID 作用域和可检验的验收规则；空作用域适用于全部候选。归因提交只包含当前候选适用的 criterion，程序按可信 applies_to 为其他条款生成 not_applicable、established、空证据和范围说明；作用域外条目必须拒绝，不静默删除或修正。正式归因仍逐项覆盖全部 criterion；缺项反馈给出真实判据、作用域和数组追加路径，只有错误顶层字段中存在唯一同 ID 条目时才指出搬移来源，仍须由模型提交完整修正结果。模型只提交 `met/partial/unmet/unknown`，另有 `established/uncertain` 证据状态、理由与原文证据。`unknown` 不能假装已确认。`core_assessment` 独立记录核心可用性、理由及 criterion 引用；false 必须关联适用核心要求的已确认 unmet/partial，null 表示待核实。部分缺陷不机械等同整体不可用。

已接受归因的来源视图直接核对正式 canonical 结果中每个完整 evidence_id 与原任务登记来源、消息、引文和 source 归属；图片还须对应真实图片及原查看记录。不重新执行当前提交 resolver，不重新解释 receipt.submitted、责任声明或已接受判词，不按引文搜索坐标，也不恢复缺少坐标的格式。坐标缺失、来源不符或原文不一致明确拒绝；合法结果只读投影，原收据、业务字段与累计账本不变。后续 Comparison 绑定和显式证据验收使用此视图；已持久化判词导出直接复用原行，不要求已完成任务重新读取输入或重新评测。

Comparison 先核验两条归因及原始 trace，照录各回答的核心可用性；源归因的完整 `task_analysis` 须与本次共同基准相同，核对文本、作用域和验收规则，不能仅凭相同 criterion ID 沿用判词。基准不一致、来源已待核或核心未知时，程序保留具体候选和既有判据，派生 `needs_review`；模型发现原材料的其他具体冲突时，只选择本方适用的程序槽并说明理由。来源 false 只有专有失败、没有双方共同适用 requirement 的已确认 unmet/partial 时，程序派生独立复核；不直接改成 true。正式 core_failure_refs 仅采用双方共同作用域的失败。Comparison 不新增或改写 finding。

Comparison 模型按程序目录 `comparison_slots` 的固定顺序评审；程序已关联共同标准和必需 finding。无 finding 的专有条款、低重要性问题与资源槽可选，填 null 时不生成展示行；私规的 strength 和中高问题仍必须保留。每个已展示格的 status/evidence_status 和关联由程序派生，未知对方没有同名 finding 不能证明其缺失。共同优势仍须由双方同一适用方面的 established 事实支持。

Workflow 安排一次独立归因重看及后续 Comparison，保留源收据和复核血缘。仍未决的样本不计 wins/both_good/both_bad，不交付、不上传，对应问题库分片等待或阻塞；复核不反复循环。自动化将末轮 needs_review 引起的直接及间接依赖阻塞识别为非暂时阻塞，不继续轮询重试，也不标为完成或允许上传。改写仅接收最终裁决文本槽位。

Agent 自主决定读取、检索、图片观察和计算步骤。提示词要求数值争议核算，但程序不强制调用某个计算工具或按固定顺序操作。内置 Profile 的 `fileSubmission=false`，通过 `submit_evaluation` 直接提交完整 JSON，程序保存草稿；`execute_code` 只提供计算与探索能力。泛型自定义 Profile 显式选择 `fileSubmission=true` 时，使用 `submit_evaluation_file` 提交工作目录内的已有 JSON 文件，完整 schema 以 `file_content_schema` 附在工具描述中，调用只传 path。`inspect_material` 按同一 Profile 的提交模式直接接收核查 JSON 或读取 path 文件，每阶段只暴露该模式的参数结构。能力声明见[提示词模块](../packages/prompts/README.md)。独立首查阶段只暴露 `inspect_material` 及读写工具，首查成功后才暴露当前 Profile 的最终提交工具。各阶段使用同一内容队列及累计修正预算。读取到内容后，程序将提交快照单独保存为 `submission-rejected.json`；文件模式反馈的 `draft_file` 指向该快照，与模型自行创建的工作文件分开。文件加载失败不生成草稿，也不反馈不存在的草稿路径。校验反馈包含 `code/path/message` 及适用的 `candidate/expected/actual`。Attribution 的具体 finding 错误另给出 `expected.target`：原错误完整 path、零起始 finding_index 与 index_base=0、原稿中可识别的 finding_id 和短 text；优先按稳定 finding_id 匹配原稿条目，不把 `/findings/5` 误当第五条，它指第六个元素。定位信息不提供证据或修改草稿；原 expected 约束与真实 normative_sources 保留。可用工具获取证据选号后修正草稿；每次内容失败为下一次修正提供三次额外探索调用；显式文件模式在当前阶段仍有内容额度时，为首次写稿、内容拒绝后的修正及成功首查后的最终稿分别保留一次已注册 fileWriter 调用。待用写稿额度最多一份、不累积，每 attempt 总使用次数不超过 1 + repairAttempts，首查与最终稿共享该上限；仅探索耗尽后消费，执行成功、失败或参数错误均计入实际工具调用。失败后若总次数尚未耗尽，恢复一次修正调用；文件加载错误不补发。写稿使用当前工作目录的相对文件名。当前阶段的内容工具始终保留在可用工具集合中，不消耗探索预算。完整错误集和草稿 JSON 内容均未变化（键顺序不计）时，反馈明确指出尚未修正的重复错误；保留剩余内容额度，所有内容提交使用同一累计上限，额度耗尽后停止，不重置提交次数。证据选号不合法时反馈当前可选范围，来源不符时给出实际材料及读取入口。真实 completed OpenAI Responses assistant 错误中，当前已注册工具的参数非完整 JSON 对象时，在同一会话反馈失败工具、当前阶段、集中工具说明和真实剩余额度；不补写 JSON、不派发参数对象。提交及 inspect_material 的无对象尝试经同一内容队列消耗预算并保存 checkpoint，读取工具消耗探索额度；事件保留 malformed_arguments 和 argument_object_available=false，不创建草稿或收据，不推断未知参数 JSON 相同。已登记证据、已有真实草稿和成功首查继续保留。未知工具、身份不符、缺终态、输出截断与连接服务错误不进入这个修正入口。模型整回合没有提交且没有报错时，Worker 用集中提示词追加一次提交提示，仍无提交记为一次执行中断，并按[运行与恢复](usage.md#运行与恢复)中的有界重试处理。Worker 在直接收到提交 JSON 或文件 JSON 加载成功后发出 content_loaded 提交事件，保存该稿的真实内容与累计序号；文件随后被覆盖仍可在显式 debug 事件中核对原稿。该事件不表示通过，不增加第二次内容计数；没有参数对象的 SDK 错误不制造 evaluation。Host 保存有效收据后才算完成；未接受时退出、超时或模型报错保留失败状态。

独立 Attribution 复核可以接收同场、同原问题的已登记 `reference_materials`，每份标记 `grader_only=true` 与真实 `source_input_id`。这些材料只供裁判核查事实，不构成本候选可见的系统指令。Attribution 的新模型提交不能选择 peer 的最终回答文本作为独立事实依据，包括已展示和延后的最终原文、已登记的原始最终生成块以及覆盖这些文本的 JSON 摘录；两份答案不同只证明交付不同，双方相对差异属于 Comparison。程序按已有 final_evidence、deferred_final_material 和 answer_generation 的原始坐标定位文本范围，不按整条消息号排除，同一消息中的真实工具、参考资料、时间戳和图片仍可引用。这是新证据选择的接收规则，已接受收据继续按原坐标恢复并校验来源与正式行，不改写历史判词，也不重新接受历史模型稿。所有模型材料和读取工具返回的 `reference` 统一为 `{evidence_index}`，模型只选择任务内正整数。程序目录保存完整坐标及已登记输入 UUID，据此选择唯一真实 raw，foreign 正式证据保存程序派生的 `source/source_input_id` 与该来源的 `evidence_id/message_index/quote`；模型不得另填 source。未知或重复登记 UUID、UUID 错配或不同题目均拒绝，不猜测来源。每份材料保留各自原末条 user 的 timestamp 字符串或缺失 null，peer 时间须与自身 raw 完全相同；不同来源时间不要求相等，不用对方时钟补本方时间，相对日期依据仍按本方实际上下文独立核查。跨来源事实不能代替本方最终交付、对错证据、数值 actual、工具责任或指令规范；指令闭环及共同作用域只读取本方引用。图片查看记录、表格对应、恢复与导出按证据的真实来源定位，不能拿 peer 的消息坐标解释成本方调用。未验证行可用同题 peer 的完整、独立工具肯定声明复核，但全部本方行和已知反证仍须保留，已有冲突不能由后续正向声明抹除。

两两判决由排名与核心判定派生，不单独判定：

| 情况 | 派生判决 |
|---|---|
| X 完成核心要求、Y 未完成 | 判 X 胜 |
| 双方都未完成核心要求 | `both_bad` |
| 双方都完成、排名同层 | `both_good` |
| 双方都完成、排名不同层 | 层更靠前者胜 |

`ranking` 是标签按层的二维数组，最优层在前、同层并列，每个候选恰好出现一次。`task_analysis.requirements` 保留必要验收条款的完整原文，核心可用性由 `core_assessment` 另选相关条款；不把原段中的条件、例外或可选内容一律当作核心要求。额外加分项放 `scoring_points`，没有实际加分项或红线时对应数组可为空。`meets_core` 表示关键交付可用性，`is_correct` 表示标准答案一致性；局部数值偏差可判标准不符，但不自动使主要交付不可用。`high`/`medium`/`low` 描述实际影响，只有使关键交付不可用的缺陷才作为核心 high 问题。

Host 在接收提交、恢复和离线校验时要求核心不可用有适用核心要求的已确认 `unmet/partial` 事实。Comparison 的程序派生与校验共用同一规则：从来源 `core_assessment.criterion_ids` 中筛选该候选适用、逐项事实唯一且为 established unmet/partial 的 requirements，作为 `core_failure_refs`，至少一项；来源核心判据中的已满足上下文保留在归因中，不计入失败引用，未被核心判据引用的缺陷也不自动加入。来源核心可用或本次待复核时该数组为空。正式判决的 `meets_core` 必须为布尔值并与源归因一致；待核实的 null 只能进入复核。可用性按整份最终交付判断，不机械绑定标准对错或 importance，Comparison 仍不能改写归因。排名必须是候选的划分，全部不可用候选同层且在可用候选之后；双方可用时，仅一方有已确认的中高重要性优势则不能并列。都差仅用于双方关键交付均不可用，都好仅用于双方可用且没有实质差距；不设置数量配额。还检查 `assessments` 覆盖全部候选、决定性发现引用既有归因 finding。这些检查不代替事实和影响判断。离线校验按源文件流式读取登记记录，行号变化时按业务标识重定位，不将整份 JSONL 载入字符串；读取期间文件变化会拒绝该来源。

模型侧 task_analysis 仅呈现当前归因候选或本对比较至少一方适用的完整条款，保留原全局 requirement_index；程序将 applies_to UUID 转为 applicable_candidates 标签，不要求模型自行解析身份。恰好重复的 acceptance_rule 仅在展示时省略，正式标准保留完整原文。比较材料中的归因不重复镜像整份 task_analysis，可信请求与正式结果仍保留全局原标准；过滤不改判据、编号或最终覆盖。

Comparison 原始 summary、tradeoff、独立首查的 observation、concern reason，以及最终复核的 concern_matches.observation、concern_refutations.observation、source_reviews.reason 没有任意字符上限；完整的来源对照、取舍与反证不能因展示长度被拒绝。非空、引用、作用域、重复选择、覆盖和有依据的取舍仍严格校验。首查揭示与成功首查恢复时，Profile 的 `inspection.materialContext` 可提供程序拥有的 `inspection_context`；Comparison 发布当前首查 concerns 在前、父未闭合 concerns 在后的 `verification_concerns`、`fresh_concern_count` 和数字 `eligible_match_choices`。选择范围使用同一证据覆盖规则计算，包含完整覆盖是否可能，不证明具体行为或责任相同；不能对应的原发现仍进入复核。上下文仅用于模型材料，不写入新的状态字段或正式判决。

Comparison 的模型提交为 `assessments`（A/B 的 summary）、同序 `comparisons`、`preference` 和 `tradeoff`。每个非空比较行提交 importance、better_candidate/null 及 A/B 的 `{summary,source_review}`；source_review 可省略、填 null 或本方来源事实的具体复核理由，程序按所在格直接绑定原标准/发现，不让模型另抄槽号、候选或关联列表。只有 optional 槽可填 null。程序的 advantage_candidates 与模型 Schema 使用同一既有事实状态限制可选范围：专有、未知或证据未确认的槽只允许空优势，双方共同事实均已确认才提供候选选择；不会将缺 finding 升级为已确认，也不会清洗不合法的优势提交。目录只保留本组至少一方适用的标准，applicable_candidates 用本组标签明确适用方；槽号只用于定位，草稿提交按数组位置绑定。双方都不适用的第三候选私规不进入比较槽。正式不适用格的 summary 由程序生成，不能采用模型擅自声称满足的文字。资源格只能 null 复核，资源排名争议不回写归因。已知 source_review、核心未知、来源标准缺失或错域由程序保留待核；程序回填 task_analysis、固定关联、状态、核心失败引用、决定性发现和排名。模型不提交 status、ranking、criterion_ids、finding_indices 或 decisive_findings，待核结果仍无胜负。

正式 `result.schema.json` 保持原有 decided/needs_review 结构。程序生成每行 aspect、criterion_ids、双方 finding_indices 与状态，不能因模型少抄 ID 丢覆盖。scope=source_only 的槽不能用于相对优势或决定性依据，任何维度引用私有规范都继承该边界；错误关联共同题目不能扩大私规范围。未绑定标准的 finding 若对方没有已接受的同方面事实，保持 unknown/uncertain，不能借“对方没有 finding”确定优势。uncertain 不能加强为 established。资源优势只使用双方共有的同种有效指标：完整耗时须双方均为有效非负值，token 须双方均为非负安全整数且各自 usage 无冲突。只有一方有数据、双方各有不同指标或 token 冲突时不允许宣告资源优势；缺失/冲突不补零。耗时与 token 分别判断，token 不等于费用，单次时延受环境影响；资源槽可省略，相似耗时或用量不强制展示。双方核心状态决定通过/失败分层；双方均可用时，独有中高共同优势自动生成赢家，反向优势并存时由唯一 preference 表达有依据的取舍，无优势不能硬选。全部未达标候选保持同层，tradeoff 仍说明剩余用途和修正代价。comparison_scope 及既有归因仅是待核来源，模型须回真实材料核查；发现事实或责任错误通过目录选择来源复核，不新增 finding、改写归因或让 Attribution 修改排名。

Comparison Workflow 每对计划 default 草稿和 verification 独立复核两个节点，各有持久化任务 UUID、默认首次提交加最多两次修正（共三次）的账本。草稿的普通 ComparisonResult 保存于 `comparison-draft.jsonl`，不产生正式对局、统计、聚类或对局点评改写。可信复核请求保留完整 ComparisonInput 与不可修改的 comparison_draft；模型最初只看到原问、标准答案、真实时刻、实际最终交付/确证生成、来源目录，以及共同要求和本方适用要求。上游 findings、met/core、评审、复核理由和排名均在首查时隐藏。排名只按共同任务表现比较，私规用于本方指令遵循核验，第三方未提供的规范保持未知。 专题比较复用既有归因时，按原来源任务及原共同规范验证程序证据；外部任务元数据仅用于只读绑定，不加入本次运行队列。

内置复核通过 `inspect_material` 直接提交核查 JSON；工具参数 Schema 由当前 Profile 提供，Worker 在同一串行内容队列内解析数字证据选择、执行校验并由 Host 保存检查点与揭示材料，成功和拒绝共用累计内容上限。显式文件模式的路径、加载与计数规则沿用本节前述泛型 Profile 契约。模型按程序给出的 `verification_check_slots` 固定顺序填写每条适用规则的 delivery、constraints 两个子槽，每格仅有 result、source_evidence、observation；candidate、criterion_id 和子槽关联由程序按位置绑定。所有子槽的实际来源引用先独立验证，程序绑定完整本方最终交付及确证生成的实际正文叶子作为审阅范围，再合并为每条原规则一个检查点：任一 contradicted 优先，其次 unverified，其次 supported，全部 not_applicable 才为条件未触发。两项完整说明保留，canonical answer_evidence 保留程序绑定的完整审阅范围；新模型提交不手选或填写此字段。该范围不是精确反证，不能自动变成可匹配的 concern；全部失败子项的行为仍须逐一核对，机械证据交叠不证明同一事实。不存在额外条件时 constraints 为 not_applicable，第三方未知 SYS 不自动制造未知；整条规则未触发时两个子槽均为 not_applicable。已接受的 canonical 检查点恢复时直接按原规则验证，不重新解释模型提交位置。result 为 supported、contradicted、unverified 或 not_applicable，分别记录真实条件及交付有支持、有矛盾、必要事实尚未核实或条件未触发；给出日期、数字或复述规则本身不能证明正确满足。supported 表示实际满足原要求；它与同项 established unmet/partial、not_applicable 与同项 established unmet/partial 或关联 established problem 冲突时，程序派生不可删来源复核。met 因条件免除可保留，supported 不因 met 下的局部质量问题单独触发复核，不将 unknown/uncertain 自动改成错误，也不改原归因、核心判断或排名。contradicted 须在 concerns 保留同一本方 requirement 的具体实际回答反证和原始来源；没有相应发现时拒绝，程序不从整篇审阅范围复制发现。unverified 保存于检查点，揭示后不能被来源当作确定满足或既定优势。额外 concerns 选择真实零起始 requirement_indices，由程序绑定完整 ID；空数组仍仅用于有本方完整 SYS/DEV 与实际交付双证的局部私规。已选 requirements 不限制对已提供本方真实规范的核验：来源目录另列确证作用于本回答的 SYS/DEV 路径、可选择的 reference.evidence_index 和完整读取边界，不重复长正文，不提供上游判词，未提供的第三方规范保持未知。未选入 requirements 的本方指令发现模型使用 requirement_indices=[]，程序保存 criterion_ids=[]，必须显式选择本方实际回答与真实 SYS/DEV 规范锚点；程序保留原选择并追加所触及规范块的完整真实坐标及全部文本叶子，不补入未触及的独立原始规范块；同一连续段落的跨文本叶子保留完整上下文，不借他方、工具、规划器或元数据来建立规范授权。检查点仍校验完整规范及实际交付双证；来源闭合不证明条款适用或违规；程序仍拒绝条件或例外不完整的检查点，原问题、工具内部提示、规划器、元数据或他方规范不能替代本方规范授权；source_evidence 可另附已登记的真实事实证据以核对触发场景及因果，仍逐项严格解析全部引用。此通道既不扩展共同标准也不证明具体语义违例。程序严格校验引用、覆盖、完整延后材料和实际图片读取，再保存核查值及读取审计并完整返回 Host 生成的揭示材料；这份任务上下文不经普通工具输出截断，后半段既有判词也须可读；它不证明 observation 的语义正确。只有 Host 接受的首查能建立 inspection 检查点，普通检查点不能造首查记录，累计计数不能回退。成功和拒绝的首查与最终提交共用同一串行队列及配置的累计内容调用上限，传输重发沿用同一个 UUID 和载荷，不另计内容。首查的模型 Schema 接收数字选号，Host 先解析为完整坐标再比较不可变 checkpoint；恢复直接用 canonical Schema 重新绑定原材料验证已成功首查，不用新的模型 Schema 重新解释。证据目录在普通工具返回前由独立 Host append 入口持久化，重复 HTTP 载荷幂等，不增加内容次数，也不覆盖草稿、首查或累计计数；spec、audit、failure 和 attempt 记录保留相同前缀，跨 attempt 继续已有编号。恢复后继续揭示后的核验，不重新盲查或超出累计内容调用上限。

揭示后核对已有 problem、采用的 strength 和比较格。准确对应既有本方 established problem 的原发现用 concern_matches 保留 concern_index、finding_indices 和对应理由；同 criterion 或相似标签不证明同一问题；主要 requirement 匹配须保留同一实际回答证据；共同适用且非 SYS/DEV 私规的要求下，已确认 problem 还可凭双方所引同一本方工具返回事实进入机械候选，concern 仍须有有效本方实际回答。返回事实按同一 input UUID、原消息及真实文本路径或 JSON 物理范围核对，仅接受 tool_result、function_call_output 或 role=tool 的 content/output/result 返回域；整个 JSON 覆盖真实返回事实可以准入，单独查询参数、请求、消息元数据、复制的用户或规范节点及他方来源不能。返回域内部的事实元数据仍是返回事实，不与消息元数据混淆。资格不自动匹配或清除发现，模型仍须确认同一行为与责任链；同要求的另一句既有问题不能覆盖当前发现。整消息或容器 JSON 证据与正文文本叶子可有不同转义形式；程序只用保留的完整 evidence_id 核对本方真实 JSON 范围是否覆盖原始正文叶子，不从 quote 反查坐标。不解析或解码任意 quote，也不因相同消息、元数据中的相同文字或部分重叠就扩大覆盖。主 requirement_index 不是显式规范证据的全部范围；索引不同的私规匹配须有所指本方适用 criterion 精确包含的真实 SYS/DEV 完整规范块，既有 established problem 显式覆盖该完整块且保留同一实际回答证据。共同主要 requirement 另可通过共享完整 USER 原块提供跨条款资格：从本方真实 governing USER 的 sourceContentBlocks 精确关联主要及目标 criterion，目标须适用本方且没有关联 SYS/DEV 块；既有 problem 覆盖共同块的全部真实来源，目标块在同一原消息中保留所有完全相同的文本路径与起止范围，并通过现有同一本方实际回答证据门。不以文字相似、另消息、他方或元数据建立来源，也不从同一不可拆段落截出新规范；JSON 按真实序列化范围覆盖来源。concern 若显式仅选择目标新增 USER 条款，拒绝借共同块的问题；此判断覆盖该消息中全部精确关联的目标块，JSON 字段键名、分隔符及外引号不当作规范正文。concern 无需重复选择已有可信共同规范。额外资格仍只允许模型显式确认同一行为和责任链，不复制 finding、不改索引、状态或核心判断，不证明复合要求的新增条款满足。完整回答与混合规范的机械范围可能涵盖不同问题，模型仍须核查实际语义；匹配省略时原发现继续待核。空 criterion_ids 的发现仅可对应本方 requirement_index=null 的 instruction_following established problem，并保留同一完整原始规范及实际回答证据，具体行为和责任链仍须实际核查；其作用域保持 source_only。未解决的此类发现由已验证 inspection 原样派生 candidate、空 criterion_ids/finding_indices 及 reason，普通 Comparison 或模型自行改写的无索引 review 仍拒绝。遗漏、矛盾或不能对应的发现不能通过确认消失，程序带入既有来源复核；纯排名异议不能指派 Attribution 修改排名。最终提交 concern_matches、concern_refutations 与必填 source_reviews；后者只提交非空的 {slot_index, candidate, reason} 选择，没有额外疑点填 []。slot_index 是 comparison_slots 明示的零起始位置，candidate 须在该槽 reviewable_candidates 中，同一格只提交一条理由；不存在的槽、不适用候选和重复选择拒绝。程序生成全部空格并绑定完整标准与 finding 关联，不复制 criterion_ids 或 review_requests。未匹配的 immutable concerns 及草稿已有 pending 请求由程序自动保留并派生 needs_review，不复制状态、原理由或完整关联。无 pending 时复制不可改写的草稿。程序只复制草稿或派生待复核请求，不改排名、点评、核心状态或归因。只有复核节点接受的 decided 结果进入正式对比与后续交付。来源冲突最多触发一轮 Attribution 复核，再建立草稿与核验两个节点；仍待核则阻塞该对局，保留原收据和 superseded lineage。正式判决类型不变，核查和确认仍属于同一复核任务。

来源复查后的草稿和核验共同依赖 `previous_review` 指向的首轮已接受核验；归因复查也引用该收据。Workflow 从父收据的 canonical concerns 和已接受数字选择派生未闭合问题，以真实输入 UUID 重新绑定当前候选，不沿用旧 A/B 代号。原证据按登记来源、完整规范条件和例外重新验证；正文、旧 checks 和整份 inspection 不复制进新 task data。`review_context.concerns` 给 Attribution 本方待查问题的 requirement_indices、reason、answer_evidence 和 source_evidence，只有该程序生成域投影为数字 references，原文和理由保持原样。新核验首查仍不见旧发现；揭示后 `pending_concerns` 加入统一数字目录。`concern_matches` 表示已有准确 problem 处理了同一问题；`concern_refutations` 只反驳父未闭合项，填写 concern_index、answer_evidence、source_evidence、observation，引用仍由证据目录绑定。反驳须有实际回答和原始反证，私规仍须本方完整规范；已接受的新首查反证不能借此删去。同项匹配和反驳、重复或越界选择拒绝。未匹配且未明确反驳的父项仍派生 needs_review，空的新 concerns、met/core 或 strength 不自动闭合它。恢复从父 receipt 与原提交选择重建相同目录，不新增状态正文或第三轮任务。

模型侧 `comparison_slots` 给出方面、纯文本标准、来源观察、适用候选标签与 pair/source_only 范围，数组位置由程序绑定，不要求复制 canonical ID 或索引。覆盖由程序固定，缺/多槽只反馈一个明确的 comparison_slot_count；独立图片/全文读取缺口仍同时反馈，依赖结构的检查等待合法结构。优势反馈指向可提交的 better_candidate 和对应 summary，不要求修程序关联。verification 尚未成功 inspect 时反馈下一动作 inspect_material；成功 checkpoint 由 Host/Worker 恢复，不能由模型创建或修补。结构和坐标通过不证明 observation、事实支持、归因责任或取舍正确，必须继续独立语义核验。

## 问题库与聚类

Clustering 模型材料与提交使用请求内短编号：观察为 O1、O2…，问题类为 C1、C2…（跨组件连续编号），组件为 P1、P2…。assignments.item_id、class_id、closest_existing、merges.into/from 与 class_updates.class_id 均引用对应短编号；组件选择仍填写名称。新类用 `assignments.new_class_index` 选择本次 `new_classes` 数组中的位置，从 0 开始；声明无需填写 key，程序生成正式结果中的 `new_classes.key` 和 `assignments.new_class_key`，不靠名称关联。同组件没有活跃类时可省略 closest_existing，程序填 null；存在候选时必须选择该组件最接近的 C 编号，缺项只反馈实际候选。Agent 在渲染材料时建立同一请求的映射，提交后精确还原真实身份，再执行组件、预算、重复归类及合并校验。未知编号或数组位置直接报错，不模糊匹配 UUID 或类名称；同一尝试的校验反馈使用相同短编号；新尝试或续跑重新根据当前材料选择，不回放上次的草稿和错误编号，避免库刷新后编号串位。正式结果和问题库继续保存原始持久化 ID，短编号不作为跨请求身份，也不写回问题库。

问题库是每个模型一份的跨 run 知识库（`data/problems/<version>.json`），由 Clustering 规则维护。每条已接受聚类决定记录：`assignments` 把每个观察（归一化 `component + label` 加完整 `definition` 精确聚合的同一描述）归入已有类或新类，或以 `deferred_reason` 记录受预算或最少支持数量限制的延期；`new_classes` 声明新类的 `component/label/definition` 以及同组件最接近的已有类和 novelty 理由；同组件无已有类时 closest_existing 为 null，`merges` 把同一组件下的近义旧类合并到保留类。疑似和已确认观察都交给聚类；类别按现象复用，不为确定程度另建类。聚类请求给出两种出现次数及示例的 `evidence_status`，库中每个出现样本保留自己的 `evidence_status`，不将疑似样本冒充为已确认。相同问题名可分别属于不同工具组件；观察只可归入同一组件内的类（已有组件的别名等同于该组件）。写库顺序是先合并、再明确维护类目录、再建类、最后落出现样本；每个出现样本保留 `class_id`、`evaluator_version`（归类收据的版本；原归因版本见归因结果行）、`batch_id`/`case_id`/`version`/`input_id`/`run_id`/`task_id`/`submission_id`/`finding_id`、消息位置、原文与源文件行号，可从问题类反查到样本、再回到原始数据；合并保留 `previous_class_id` 与 `class_merged`/`occurrence_moved` 事件，被合并类的 label 与 aliases 追加到目标类。入库按 `(class_id, input_id, finding_id)` 幂等，重复 report 或续跑不会重复计样本。

数量由程序硬控，提示词只做引导：

- 计划期把该模型本 run 的 `maxClassesPerModel − 活跃类数` 和 `maxComponentsPerModel − 活跃组件数` 分别均摊到全部分片；绑定任务时按该分片实际观察到的未知组件数收窄 `max_new_components`，不得突破预留份额；
- 提交必须覆盖全部观察且只归一次，`class_id` 必须是库中活跃类，新类必须被至少一个观察使用且覆盖样本数达到 `minSupport`；
- 同一组件内，`新类 label` 归一化后命中活跃类 label 或 alias 时直接拒绝，要求复用该 `class_id`；
- `活跃类 − merges + new ≤ maxClassesPerModel`；新组件只能来自本任务观察到的组件，并受 `maxComponentsPerModel` 限制；
- 每次归类都检查相关同组件近义类；达到 `consolidateAt` 时扩大整理范围并输出 `merges`。合并不增加当前任务的 `max_new_classes`，腾出的预算在后续规划时重算。
- 写库按模型锁住读、合并、校验和保存；不同 run 共享同一模型时不会互相覆盖。所有模型的上限校验通过后才写文件；若有模型超出 `maxClassesPerModel` 或 `maxComponentsPerModel`（例如并发 run 或手工下调上限），本次报告不写入任何模型的库，并提示调高上限。

类可带可选 `category_paths`：最多三条自由主题路径，每条最多三级，同一路径不能重复层级，同一类不能重复路径；每级填写简洁的单行纯文本名称，禁止 ASCII 标记分隔符 `< > [ ] { }`、C0/C1 控制字符及 Unicode 换行分隔符 U+2028/U+2029，允许普通中英文、数字、emoji、括号、斜杠和破折号。无效名称按具体层级原样返回错误并要求重新填写，不自动清理。Agent 提交与正式结果、请求中的现有目录均校验；应用目录收据时再次校验实际创建、待应用的更新及合并后的最终路径，拒绝污染写入。已应用更新按原幂等规则跳过，复用已有类时不提交新路径；被跳过的整理更新不能替代合并最终路径的校验。不重验未变更的旧目录或改写历史收据。缺失或空数组表示未组织。主题不建立新类身份或推断根因，观察的责任组件和证据确定程度保持不变。类定义只概括行为与适用边界，不新增未证明的成因、禁令或输出义务，不固定严重程度、核心可用性或胜负。类目录不是事实证据。合并保留各类路径，超过三条时必须明确整理目标类。

`class_updates` 只维护当前活跃类的可选 `label/definition/category_paths`，必须有 `reason`，不修改组件或历史归因。`class_updated` 事件保存修改前后元数据、理由及 run/task/submission 身份；按 submission 与 class 幂等，重放旧维护不能回滚后来的维护。长期名称和定义不能用当前请求 O/C/P 编号解释含义，真实业务型号和错误码保留。

延期不是失败或已归类，不写类或出现样本，观察与理由仍保留在正式聚类结果。显式 `recluster --task ...|--all` 创建新 UUID 任务，只重新处理尚未被后续任务承接的延期观察，并用当前目录及扣除其他未完成任务预留预算后的余量规划；原收据及本轮提交次数不变，不自动跨 run 重试。问题库统计与主题展示按 `(input_id, finding_id)` 计算独立缺陷数，多组件和多主题仍保存全部关联。

显式历史来源复核请求见 `schemas/clustering/occurrence-review.schema.json`，通过 Workflow 的 `reviewProblemOccurrences` 公开入口先沿原 Clustering 的 input 依赖重建 Attribution 观察，精确核对该组件下的 input_id、finding_id、原 source 位置、消息、原文和 evidence_status；原接受 item 与实际 assignment 必须对应这个观察及原问题类，同组件 merge lineage 可以解析到当前类，不能用同名的其他 finding 或无关类替代。text/json 证明只收完整当前自包含 evidence_id，每项至少有 owner 原材料证明，可附加原归因 source scope 中的 peer 证明；拒绝独立 source、图片证明和原 source scope 之外的输入；坐标由 Tools 重读，操作理由是显式来源审计判断，不能把坐标有效声称为程序已经验证语义。默认 preview 没有写入；模型库锁等待后二读原 Clustering scope、items/assignment、全部 Attribution 依赖的 owner/receipt 和登记 inputCatalog，原来源发生变化则拒绝。apply 使用同一个模型库锁追加 `occurrence_rejected` 事件；事件 UUID 与决定一一对应，重试同决定不新增，复用 UUID 改决定直接报错。

事件 detail 保存 evaluator_version、原决定及每个目标的 occurrence UUID、`input_id/finding_id/component_id` 关联、复核时 class_id、原 Clustering run/task/submission 和原 Attribution task/submission。原 occurrence、accepted、类 UUID 和 lineage 保留；有效投影排除该关联的所有物理行，跨同组件合并、续跑或重放旧收据均不能复活。多组件只撤明确错误项，剩余有效组件仍保留独立 finding 计数；多主题不会重复计数。默认类内样本列表在去重、排序和分页前统一过滤，总数与页面行使用同一集合。类/组件数量与硬 cap 不变，目录边界另用 class_updates 维护。

该维护不是新的 Agent 判词，也不自动按 uncertain 状态或类名撤销，不改归因责任或恢复被撤关联。apply 只追加问题库事件，不调用 reportRun，不回写运行状态、正式结果、历史报告、stats 或 statistics-log；后续正常报告的当前库 occurrences 使用有效集合，而 assigned/new-class/merge 决定数保留已接受收据的行为账本。外部统计上传结构保持冻结。

聚类任务失败时库保持不变，当天问题仍保留在 `attribution.jsonl`。

## 改写

改写阶段可选（配置 `rewrite.attribution` / `rewrite.comparison` / `rewrite.clustering`），把已接受的归因、对比或聚类结论润色为更简洁规整的表达。三项默认均开启，可显式关闭；每个已启用阶段的源结果初次规划一个改写任务，接受后的补缺或刷新另建 UUID 并保留原任务与收据：对比组默认写派生 `verdicts[].reason`；启用 `rewrite.comparisonItems` 时，初次任务还改写全部 `comparison.<行号>.<候选>.summary`，自动化强制启用此项。以已确定的胜负和该对局的原裁决、逐项表现生成具体偏好理由；都差时保留原裁决已确定的相对优劣、依据及必要限定，原裁决未确定本对候选的相对优劣时不自行选优，也不宣称没有差距；归因改写覆盖 `summary`、非空的 `correctness_reason`、finding 的 `text/reason` 与 `assessment.observation/impact`；聚类改写覆盖新类的 `definition/novelty` 、`merges[].reason`、延期理由及类维护的定义/理由，没有文字槽位时返回空改写。

- 对比裁判继续盲测；Workflow 在改写前将槽位称谓还原为真实组别与模型名称（如 A组Fast、B组Fast），槽位 id 不变。
- Rewrite 的模型侧 label/text/context 将 ASCII 尖括号显示为全角符号，保留标记名称、属性值、数字和既定判断；正式请求、源结果、id、preference 与 forbiddenPrefixes 保持原值。展示替换不代表原回答使用全角字符。提交 text 仍须为字符串，对象不会转换为文字。
- 输入是 Workflow 选定的文本槽位（`items[].id/label/text`）及 case 的批次/case ID 或聚类的批次/模型定位信息，不含原题、原始消息、证据和 finding 引文；模型看不到可用来重新判断的材料，只能润色。
- 提交必须与请求一一对应：相同 id、相同数量，不新增、不遗漏、不重复；真实组别与模型称谓、事实相关的数字与单位、限制条件和不确定性原样保留；裁判无关的自评打分/置信度分档可以删除，不拿用户指令充当具体优点。
- 对局偏好改写必须以真实胜者名加“更好：”、或“双方都好：”“双方都差：”开头；程序校验该前缀与已接受判决一致。“双方都差：”后可以说明原裁决已有的相对优劣，不改变排名、赢家字段或统计；“双方都好：”仍不得改成某方更好。当前文案按收据接受时间逐槽取最新值，同一接受时间按任务清单次序后者获胜；未触及槽位保留此前文案，重放旧收据不回滚新文案。`rewritten.evaluator_version` 取最新接受的改写收据版本，每份历史收据仍保留并独立校验其原始版本和完整评价；被覆盖的历史文本通过状态差异记录恢复。
- 显式逐项改写只请求 `comparison.<行号>.<候选>.summary`；本格原文放在 `text`，同项对照和已确定的本项优势放在只读 `context`，不含证据；不把对照信息复制为点评前缀。Workflow 通过 `forbiddenPrefixes` 指定不可作为前缀的呈现标签，Rewrite 校验拒绝复制标签，避免将本项赢家名称贴到另一方事实前。每格先写具体得失，保留局部优势、各自约束与不确定性；仅更新这些槽位，已改写偏好、方面名、优势标记和引用保持不变。
- 定向修复在任务数据中保存 `rewriteSlotIds`，请求必须与该非空、无重复的已知槽位集合完全对应；未知槽位在派发前拒绝。`executionScope` 保存本轮任务 UUID 清单，必要的独立复核后续任务随源任务加入清单；成功任务及其他范围外任务不会进入请求；同 run 冻结范围时不发现新增输入。准备修复保留既有源结果及文案，接受后只合并请求的槽位；旧成功任务的 attempts 和判决版本不随修复变化。CLI 选择与释放范围见[使用指南](usage.md#只补失败与同类故障熔断)。
- 正式结果不变：`attribution.jsonl`、`comparison.jsonl` 保留裁判被接受时的原文；`ranking`、`meets_core`、`is_correct` 和证据不因改写变化。改写附在对应阶段结果的 `rewritten` 字段：归因为 `evaluation.rewritten`，对比为 `rewritten`，聚类为 `result.rewritten`（内容为 `evaluator_version` 与 `rewrites` 槽位文本），不单独生成结果文件或业务日志。
- 看板同时展示原始输出和改写后内容，聚类详情在运行总览。问题库的类身份、归属与原始定义不被改写覆盖。
- `report.md` 与 `task_summaries.md` 优先展示改写文案，离线校验仍以正式结果收据为准。导出保留完整已接受原文与改写，名称展开不另设点评字数上限。
- 完整对比改写续跑时按源结果实际保存的槽位补缺，只请求缺失文字并合并回填，已有文案和源评测保留；接受后的补缺或显式定向刷新新增 UUID，相同来源、范围和槽位的未完成任务复用并保留已花提交额度。交付校验检查该源全部当前改写任务及缺失槽位，历史已接受任务不能掩盖尚未完成的刷新。
- 普通续跑可以开启或关闭改写：已接受的改写保留，未完成且被关闭的改写任务不再计划；显式固定范围内按已准备任务执行，不重新规划开关。已接受的评测结果不受影响。

## 证据与导出

对比结果 JSONL 和逐题总结 JSONL 的每行都以 `request_time`、`has_standard_answer` 两个顶层字段开头，其后是产出该行的 `evaluator_version`。`request_time` 取该组第一个版本（按 `comparisons` 声明顺序）的输入原值，缺失时为 `null`，不受盲测标签影响；`has_standard_answer` 为布尔值，表示本题是否有有效标准答案、是否进入归因的对错判定，与 `ground_truth.available` 一致。

模型可见材料与工具把原文及定位信息同 `reference` 选号对象分开。引用只提交 `{evidence_index}`，图片可另附 observation；编号是本任务从 1 开始的正整数，未知、非整数、越界和额外引用字段均拒绝，不自动选择或替换材料。程序用同一同步登记 helper 维护 append-only evidenceBank：同一完整坐标复用编号，新的坐标只追加；目录不存原文、引文、observation 或哈希。初始材料、已实际返回的 read/search/table/image 页及核查成功后揭示的程序材料使用同一目录；原始消息值、真实股票代码和脚注标记保持不变。

完整 EvidenceReference 与 evidence_id 仍是程序的公开坐标契约：`ev_<登记输入 UUID>_<消息索引>_<text|json>_<起>_<止>_<路径>`，图片为 `ev_<登记输入 UUID>_<消息索引>_image`。Host 按当前任务实际绑定的来源校验目录及引用，保持来源、归属、原文范围、规范闭环和图片查看证明的现有要求，再展开正式结果的 evidence_id/message_index/quote；数字选号不证明语义正确。索引、路径或起止范围无效时拒绝，不会从错误坐标猜测引文或把越界范围改成整段；模型反馈提供可选编号范围及对应材料，不返回完整坐标供抄写。优先复用同候选、同消息的实际读取记录，长片段以 `quote_preview` 展示开头并标记 `has_more`，其 `reference` 仍指向完整已读片段；没有合适证据时按 `read_request` 继续读取。读取、搜索和展开共享公共工具包中的字符串/JSON 表示，不进行其他模糊匹配。可引用消息内的原始字符串，也可引用该消息按两空格缩进显示的 JSON 连续片段，包括结构化工具返回的字段和数值；`search_trace` 同样支持查找这些片段。图片提交选择图片 `reference.evidence_index` 后增加 `observation`，正式结果展开为 `[图像观察]`，工具审计必须存在实际 `view_image` 记录。Host 校验引用、索引和判决关系，事实判断仍需[质量复核](quality.md)。

初始材料是渐进式披露的首屏：`initial_material` 只展示 `initialContextChars` 预算内的投影消息，剔除大体积 `input_messages` 与模型参数，证据引文同样计入预算。实际回答链上的 system/developer 单独放入 `instruction_sources`，完整保留原文，不在首屏消息中重复；程序沿最终回答对应的 LLM 输出及其真实 assistant 历史提取嵌套指令，排除工具规划器上下文。Criteria、Attribution 与 Comparison 的可信来源和正式规范保留原始字节及完整坐标。盲测只作用于模型展示与工具返回：Host 将可序列化 presentation 传给 Worker，工具在按原文分页和登记证据后脱敏展示文本、移除消息身份字段；ID、路径、分页偏移和图片字节不变，完整坐标始终解析原始输入，不建立展示坐标映射。`final_evidence`、`initial_material[].evidence`、`instruction_sources`、`citation_inventory` 和 `table_check_results` 的生成证据目录使用引文与 `reference` 展示；原始消息值中的同名字段保持原样，不递归改写。`read_trace` 可用 `path` 选择原始文本或结构化字段（对象、数组、数字、布尔值、null），省略时读取整条消息 JSON 并给出文本路径目录。字符串使用原文本坐标，结构化字段使用其在整条消息 JSON 中的真实坐标；分页 offset/next_offset 始终相对于所选字段，模型不计算证据坐标；`source` 标明当前坐标来源，分页保持来源不变并使用返回的 `next_offset`。`read_trace` 和 `search_trace` 在 `maxOutputChars` 内分别缩短原文页、减少检索条目，始终完整返回配对的引文与 `reference`，不交给通用字符截断；其他工具超预算时仍截断并将完整内容存为可分页产物。

任务判据目录只选择本轮用户交付要求、标准答案和真实候选用户约束，SYS/DEV 不整份升为任务判据或共同优势。内部指令仍完整保留在本方材料中，由 Attribution 和独立复核按真实指令层级、触发条件与实际行为单独核验；未入 requirements 的私规用 source_only finding 与完整本方规范和实际交付证据闭环，不能借共同问题扩大作用域。

Workflow 用原整组去身份映射及当前候选的真实 system/developer/user 完整规范块精确关联 criterion，保留标题、正文、跨文本叶子条件和例外，不按近似含义或中文标点拆义务。`criterion_instruction_sources` 保留真实 evidence_id、消息、路径及完整原文；criterion_assessments 仍按该关联补入规范，模型须提供实际交付或执行证据。Attribution 的公开 `attributionNormDirectory(request)` 先按原 requirements 顺序列出本方适用且有可信真实规范绑定的项，再列未被这些项完整覆盖的本方 SYS/DEV 与未关联 USER 原块；目录只做物理来源分组，每项为 `norm_index / roles / requirement_index / evidence`，跨角色的真实规范束保留全部 roles。当前请求必须提供 `answer.norm_directory`，启动模型前与真实来源严格比较内容和顺序，未知来源不借 peer 补造。模型只提交一个 flat findings 数组；instruction_following 每条只选 `norm_index`，禁止另填 assessment.requirement_index，程序从所选项生成共同要求索引或 null；未知规范只能 null 且 uncertain。其他维度禁止 norm_index，仍按明确的本方 requirement 关联处理。所选完整规范只作为来源，不证明条件触发、遵守或违反，不改 status/core；未选项不自动补入，正文或 reason 不用来猜关联。完整原规范已由真实 instruction_sources.content、同坐标 initial_material.value 或可信 criterion 原文展示时无需再次工具读取；只有真实隐藏或截断的选中长块须完整 read_trace。每条 final_answer finding 的本方最终正文及图像审阅范围由程序从 raw 真实 assistant/final_answer 内容绑定，显式 evidence 可为空；非最终阶段仍需具体证据。自动范围不证明任何语义结论，延后最终正文与图片准入门槛保留。责任索引先解析本 finding 原提交 evidence 数组，再追加规范与最终范围，同一完整坐标去重且不重排原证据。程序按 flat findings 原顺序生成 f0、f1 等本回答内 ID，真实发现无任意八条总量上限。已接受 canonical 收据按原坐标直接恢复，不重新解释新 selector、不添加新证据、不改变历史 ID。新提交任何维度 problem 关联有效适用 requirement 时，不能同时声明该条 established/met，改 problem 为 uncertain 也不能绕过；partial/unmet、判据 uncertain 和真实无关联仍保留自身语义。私有规则不扩大共同核心作用域，程序不代判违规或核心可用性。

`citation_inventory` 定位最终回答引用的完整来源块，记录实际 footnote/trace 编号、vis-html 资源 ID、引用位置、来源与 resolved/ambiguous/unknown 状态；trace ref 对应 serial_number/ref，trace anchor 对应可追溯工具的 action_id，按真实属性匹配。vis-html ref 只匹配真实工具返回或实际模型可见工具消息里的同 ID 资源对象，包括 stdout JSON，不从技能文档示例或仅含 ID 的正文构造来源。一次工具返回可有多个来源 ID；模型可见上下文新增的 serial_number 单独标记 model_visible，不冒称原工具返回。每条 occurrence 保留原标记证据并附 context：同一真实文本叶子内、以空行分隔的连续原文段落及其引用、read_request 和 end_offset；无空行的表格或长段落保留整体，不拼接其他叶子，也不自动划定语义主张。状态只描述是否能定位来源，不证明整句支持或最终渲染。支持粒度按本回答真实引用协议及相邻标注组核验，可由同组多个来源共同支持事实或段落，不自创单个编号必须证明全部分句的要求；第三方协议未知时不强套本产品语法或主张粒度。操作或文件 anchor 的范围还须核查对应真实调用、取得的文件与可用全文，不把 stdout 摘录缺值直接等同文档缺值。模型视图中超过200字符的来源与上下文展示 quote_preview、has_more、真实整段 reference、read_request 和 end_offset；按返回 next_offset 读取到来源终点，再判断支持关系。来源歧义不猜选，未知不直接判伪造。数值、单位和实体语义核对使用等长遮蔽后的引用标记视图，原文、偏移和正式证据保持不变，注脚编号不成为指标值或实体名称。

正式证据必填程序 evidence_id，并保留同坐标解析得到的 message_index/quote；规范自动追加和完整段落展开也保留各原始叶子的坐标。Comparison 直接投影这些坐标为 reference.evidence_index，不从引文反查重复位置；超过200字符时提供预览、read_request 和 end_offset。来源、路径、范围及原文不一致即拒绝。证据覆盖只按真实范围；JSON 覆盖文本须实际包含该完整叶子的序列化范围。最后模型生成与捕获回答只有真实生成链及完整有序文本叶子逐字相同才允许同范围对应，不根据偶然相同文字或图片未知状态推断支持、渲染或责任。

Attribution / Comparison 的 `modelInput.task_focus` 先展示原问、`task_analysis.goal`、真实 `ground_truth` 和每条回答的定位。可见 `final_answer` 不超过16000字符时整段复制，超过时只保留原 `final_message_index` 与 `deferred_final_material` 目录，不截取局部。`question_timestamp` 取原始最后一条 `role=user` 消息的 timestamp 字符串，缺失或非字符串为 null，不解析自由文本或使用评测时钟。null 只说明原生字段缺失，其他可见时钟仍须从原始上下文核验，不能借缺字段断言没有时间依据。focus 的共同要求按 Criteria 完整候选作用域检查，保留 id、全局 `requirement_index`，1000字符以内的 text 完整复制，长文留在完整材料。模型视图的 `task_analysis.requirements` 每条都显示原数组零起始 `requirement_index`，原 id/text/applies_to/acceptance_rule 保留，不按本候选适用列表重新编号。focus 与索引只用于呈现，可信 request、正式镜像与证据不新增字段。

模型选择未知、非整数或越界证据编号时拒绝提交，反馈给出当前可选编号范围；不自动补选证据。已解析的证据不符合来源、交付或规范要求时，`expected.suggested_evidence` 保留真实短引文；已登记的坐标重用 `reference.evidence_index`，新建议只给实际 `read_request`，完成读取后才分配编号。拒绝反馈及恢复错误呈现不增加目录，避免 HTTP 拒绝中的临时 audit 分配未持久化编号。模型先核对片段是否支持原判断再选择，不将建议直接视为已接受证据。程序内部的完整坐标仍严格校验，不猜测无效路径或范围；对象与数值路径的建议使用真实 JSON 片段，无效路径没有建议引文，读取请求退回原消息以定位真实字段。

每条对比行给出 `ranking`、`assessments` 与派生的 `verdicts`（键为本场两个稳定版本 ID 组成的模型对）。派生判决使用 `win` / `both_good` / `both_bad`，后两种的赢家字段为 `null`；`verdicts[].reason` 原文是程序生成的规则概述，改写槽位则结合逐题事实直接解释偏好；具体差异与反向事实来自 `decision_basis.tradeoff`、候选评估和归因 findings 中。评语中的 `【候选A】`、`候选A` 等会按盲测映射替换为展示名称；A股、A+H、A浪、方案A等题目术语与证据原文保持不变。汇总分别统计各版本胜出数、都好数和都差数，三类互斥且相加等于有效比较数，失败不计入上述分类。

归因任务使用单份 `answer`。有标准答案的 `correctness_evidence` 至少包含其 `final_message_index` 对应的最终回答，可追加本方真实工具返回、规范或执行材料作为佐证；所有坐标逐条验证，peer 不冒充本方实际交付。`numeric_checks.evidence_index` 指向的每条实际值证据仍必须来自本方最终回答。无标准答案不提交这些字段。正式归因行包含 `task_id`、`submission_id`、`input_id`、`case`、稳定 `version` 和 `evaluation`（判对结论、理由、展开的原文证据）；评语不做盲测标签替换。结果文件位置与恢复规则见[运行产物](usage.md#运行产物)。

`stage` 表示发现属于上下文回溯、推理、执行或最终回答；`stage_trace` 由程序从原始消息生成，包含工具、位置、置信度与来源。只回溯当前 finding 引用的证据；无法唯一定位时保留候选工具，不猜测确定来源。

Agent 初始材料的 `original_answer_timing` 只提供 `finish_seconds`（完整回答完成耗时，秒）；登记信息仍保存原始首 token、首段与完成指标供追溯，但首段时刻不代表最终答案可用。`original_answer_usage` 从被评输入 `meta.usage` 提取输入、输出、总 token 和缓存输入，记录来源字段、总量依据及数据异常。A 的 `input_tokens_details.cached_tokens` 和 B 的 `cached_read_tokens` 统一为 `cached_input_tokens`，它是输入子集，不重复累加；未记录总量且输入、输出都有效时才相加。缺失或无效指标为 `null`，总量冲突与缓存超出输入会标记异常，不使用裁判 SDK 消耗或累加 trace 快照。耗时和 token 分别用于等待与资源效率判断，正文只引用支撑实际得失的数值，不强制展示全部字段；报告沿用已接受结论，不重读来源来重评。

逐题总结包含问题、要求、判决、同项对比理由、各方优缺点、得分点、red flags 和原始回答体验对照。逐项使用可比数据，未知指标不填零；token 量不等于价格，单次耗时不代表长期性能。

### 数值与实体核验

程序仅从可信 `ground_truth` 提取 `numeric_references`，按来源顺序提供零起始 reference_index、保留标准原精度的 expected 和完整来源 context；支持正文、结构化值和标准表格中的多个数值，排除可识别的证券代码、日期及编号。模型的 `numeric_checks` 只提交 label、reference_index、actual、scale、mode 和指向 correctness_evidence 的零起始 evidence_index；程序绑定标准原值 expected 并计算 matches。工具返回或自算值不进入标准目录，目录为空时提交 Schema 要求 numeric_checks=[]；补充事实继续按原来源核验并写在 correctness_reason 或 finding 中。正式结果及 comparison 的 evaluations 保留 expected/actual/scale/mode/matches/evidence_index，不保存 reference_index。

expected 由程序保留标准原有小数位与科学计数法指数，actual 保留最终回答的原数值及方向，不能先换算再声称是原文。提交端 actual 可为字符串、有限且不丢失整数精度的 JSON 数字或 null；程序将数字明确转为正式字符串，保留负零；scale 须为字符串。非有限值、不安全整数和最终回答不存在的数值拒绝。程序使用十进制整数运算：连续量以 rounded 按标准末位精度四舍五入，整数计数等离散结果用 exact 精确比较。未交付的目标填写 actual=null，程序生成 matches=false，并引用支持缺项判断的最终回答，不以0占位。已有未通过的核对不能判 is_correct=true，也不能用 null 回避已确认错误。提交安全检查和正式验证共用数值规则，无关结构错误不遮蔽当次可检查的非法标准选择、实际值或单位冲突。

[单位校验](../packages/agents/src/attribution/units.ts)回到原最终消息定位引文中的数值，读取邻接单位、该单元格同列的明确单位表头，或该表紧邻前一段落声明的单一单位，不因引文裁去单位而跳过。列单位优先，表级声明不跨表或跨无声明段落，也不用于日期、代码和编号列。天、交易日、个交易日按计数核对，明确的日期坐标不当作计数。同维单位的 scale 须符合已登记倍率；核对表项两端量纲不同时保留 scale="1"、matches=false 并判标准不符，不能把质量与体积、百分比与百分点直接等同。同值对应多种单位或单位不能唯一定位时须重取证据；非1倍率缺少可验证单位依据时拒绝，未知单位、复合单位及需密度等额外条件的推导写入 correctness_reason，不伪装成单位等价。

模型须逐项填写可直接比较的同口径点值目标，单一目标也不例外。原题或标准明确给出容差、区间、上限或下限时，按原条件核验该目标，不将中心值或边界套成点值相等；该目标不入数值表。最终回答仅以分数、名单、图表或需额外条件的表达交付，须计算或解码才能比较时，也在 correctness_reason 保留原规则、实际交付、过程和判定，并引用 correctness_evidence，不伪装成逐字 actual/expected，也不当作缺项。最终回答已直接给出的计算结果仍可按原值入表；日期、代码按原任务核验。单一及多目标的比较方式、抽取和覆盖均须语义复核，程序不根据标准文本形似单个数值强制添加表项；它严格验证已提交表项的标准绑定、原值、单位、精度和判词一致性。目录为空或没有直接点值目标时提交空表，混合情形保留其余直接点值目标；数值表通过不代表整份判断正确。

原文数字匹配保留数值边界与方向：识别明确的“跌”及下降表述、量词前的单字中文数量（包括天与交易日，不包含日期中的“日”）、完整公式中的减法右操作数；紧接半年、季度或月份标题的年份不并入前一小数。数值未出现在引用时，反馈附上实际解析的 quote，不把模型填写的 observation 当作原文。

[表格来源核对](../packages/agents/src/attribution/table-review.ts)为可解析的最终代码/名称表预计算 `answer.table_check_results` 并由 Workflow 提供给归因；summary 统计全部行，rows 仅展开经证券代码规范化后的疑点行及真实证据。目录只识别带表头分隔行的标准 Markdown；JSON 行、stdout 空格表、Python 字典打印等不自动成为来源表。没有可比来源表时，实际回答行保留 unverified、原文坐标和空 sources，不虚构匹配或冲突；未收录也不证明原材料没有支持或反证，须继续读取真实来源。模型直接检查疑点与两侧原文，按对象、时间和加工过程解释差异；额外探索仍可调用 check_table。提交校验从原始消息重算，拒绝预计算材料缺失或不一致，不把计算完成声称为模型逐行阅读。conflict/ambiguous 行必须有引用最终行与来源行的 problem finding。`source_review` 是程序生成的只读事项目录，每项包含 `kind/reason/requires_review`；kind 区分 unverified、unresolved_conflict 和 invalid_material。requires_review=true 的事项要求 Comparison 输出 needs_review。unverified 不能单凭来源缺失判答案错误；未断言具体代码的文字占位符仍按任务要求评审。六位证券代码相同且仅一方省略 .SH/.SZ/.BJ 后缀时可对应；交易所后缀按大小写统一识别，两边明确不同交易所不能合并。

剩余纯 unverified 行仅在以下条件全部成立时不强制复核：本方已有共同 requirement 的 established unmet/partial 核心失败，关联该失败条款的 established/high problem finding 用最终行及原始来源行闭合程序重算的确定冲突；对方核心已确认可用且没有来源待核；本方没有材料校验错误、歧义或其他未解决冲突。程序只将这些事项的 requires_review 设为 false，原因仍保留在可信请求与模型材料，未确认行不能成为错误证据或比较优势。私有失败、核心未知、双方可用或对方待核不满足此豁免；不改归因、证据或核心状态，也不自动生成排名。

独立归因复核可用可选 `table_resolutions` 逐行选择本方完整表目录的正整数 table_index，提交零起始 row_index、outcome（supported/conflict）、reason 和 evidence；程序还原正式 table_id；首轮不得用它解除疑点。只接受预计算中的疑点行，每行一次；已匹配行不能提交解除决定，证据须覆盖最终行与全部既有来源行。supported 仅用于 unverified 行，还须引用可信、非代码执行工具返回的完整文本节点，且该节点本身是可解析的肯定代码对应声明。已有原表反证冲突不能仅靠后续正向声明解除；模型代码执行输出、同词共现、否定、示例或截句均不能作为独立支持。conflict 还须有同时引用两侧原文的 established problem。仅写解释不能解除来源疑点；一次独立复核后仍未解决的样本按前述未决规则处理。

### 文案校验

偏好改写通过 `preference` 锁定既定对局结论，双方都好的文案拒绝常见整体胜出表述；都差文案允许保留原裁决的相对优劣，是否忠实保留主体、取舍和失败边界由语义复核确认；责任定义明确根因未定位却列组件时退回修正。这些检查只拦截明确矛盾，不能取代真实题集的语义复核。聚类的未知编号或跨组件归类反馈使用本次请求的短编号，不自动更正或猜测归属。

改写硬校验槽位完整、唯一、文本非空、既定偏好及 Workflow 指定的禁止前缀。`validate --require-rewrite` 对所需范围的全部已保存槽位应用当前机械契约，不只检查最近一次改写收据中的子集；语义复核单列为 required。数字保真和简洁长度由提示词引导、结果复核，不因数字集合变化或轻微超长触发结构修复；它们不是事实正确性的证明。

非 instruction_following findings 的 assessment 省略 requirement_index 表示没有关联，程序生成正式 null；合法关联使用原全局 requirements 索引。instruction_following 只提交 norm_index，程序绑定真实规范及其 requirement_index，未知规范 null 仅 uncertain。Comparison draft 的 source_review、better_candidate 和 preference 可省略，分别表示没有来源复核请求、没有相对优势声明与没有偏好，程序生成 null；正文和重要性仍必填。Verifier 的 source_reviews 只提交非空索引选择，程序生成全部空格；非空理由仍严格绑定本方已有要求或 finding。目录 reviewable_candidates 明示可复核候选，资源或不适用格不能请求修改来源。Schema 不完整不隐藏已可独立判定的引用、数值槽或来源复核范围错误；同一修稿反馈一次列全，派生条件不成立时不追加后续噪声。
