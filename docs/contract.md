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

## 输入与输出的分层

这里的“输入”有两层，不能与 Agent 的输出混为一个 Schema：

1. **原始评测输入**：来源文件中的 JSONL。它允许由 `a` / `b` 适配器接入不同结构，不维护一个覆盖所有来源的总 JSON Schema；[input.ts](../packages/workflows/src/comparison/input.ts) 和适配器负责预检、归一化与业务校验。
2. **Agent 请求材料**：Host 为某个阶段拼出的 `ground_truth`、`library`、`candidates` 和依赖结果。根目录 `schemas/<stage>/request.schema.json` 只是 Host 到 Agent 的内部装配护栏，不是数据源契约；如果请求字段变化，同步修改[材料映射](../packages/workflows/src/comparison/binding.ts)和对应 Profile。Workflow 可通过 `AgentBinding.modelInput` 显式提供模型展示投影；Host 只用它渲染提示词，Schema、证据展开和业务校验始终使用内部 `request`。

阶段输出则分为两种：

- `submission.schema.json`：模型通过提交工具返回的 JSON，主线四阶段最多两层对象。Attribution 模型直接选择本 task 内从 1 开始的证据编号；Host 在结构化选择后恢复完整坐标再做业务校验，按最终展开位置生成本条回答内唯一的 `finding_id`，模型不提交该字段；不提交可从请求推导的 `has_standard_answer/task_analysis`。有无标准答案均保留固定对错字段；无标准答案时填写规定空值，具体见[归因与共同基准](#归因与共同基准)。Profile 可按可信请求提供模型展示用 Schema，实际提交仍经过本地结构和业务校验。Comparison 同样不提交共同 `task_analysis`，也不提交自己的证据；核心状态、失败判据以及比较格 status/evidence_status 由程序从既有归因派生，提交只保留同序固定槽的 importance、普通格 better_candidate、整体胜出 preference、相对倾向 relative_preference 与各方 a_tradeoff/b_tradeoff；关联、覆盖与排名由程序派生。
- `result.schema.json`：Host 展开证据并接受后的阶段结果。证据保留程序生成的必填 `evidence_id + message_index + quote`，finding_id 保留以维护问题库的样本血缘。

下表描述 Host 接受后的阶段结果；模型提交与程序补入的字段在后文分别说明：

| 阶段 | 一次处理 | 输出内容 | 下游用途 |
|---|---|---|---|
| Criteria | 同题、同标准的一组候选约束 | 从本轮问题与候选用户上下文的原文目录选择来源，标准答案留给后续归因核对；形成带 ID、`applies_to` 和 `acceptance_rule` 的 `task_analysis`，不向模型展示 SYS/DEV、回答或工具轨迹 | 写入 `criteria.jsonl`，作为归因与对比的共同基准 |
| Attribution、普通 Comparison | 一条已标明版本的回答 | 条件性的 `is_correct`、`correctness_reason` / `correctness_evidence`、可选的 `standard_conflict`、`criterion_assessments`、`core_assessment`、`summary`、有证据的优点及确定/疑似问题 `findings`；Host 在接受结果时加入 `has_standard_answer` | 写入 `attribution.jsonl`；Comparison 读取去身份视图，Clustering 读取问题观察并维护问题库 |
| Comparison | 两个候选 | `status`、复核请求、分层 `ranking`、核心分类、带 criterion ID / 状态 / 证据状态的逐项对照及决定依据 | decided 写入 `comparison.jsonl`；needs_review 写入 `comparison-review.jsonl`，不派生判决 |
| Rewrite | 一个归因语义组、对比或聚类结果的文本槽位 | 模型返回同序 `rewrites: [{id,text}]`，槽位 id 按位置固定，不含判定、证据或新增条目 | 按槽写入源结果的 `rewritten` 字段；报告与逐题总结优先展示改写文案 |
| Clustering | 一个模型 × 一个批次（可按 case 分片） | `assignments` 把每个观察归入已有类或新类，`new_classes`（key/component/label/definition/最接近类/novelty），可选 `merges` | 写入 `clustering.jsonl`；run 结束把决定写进该模型问题库 |

Criteria 绑定来源、Attribution 绑定选择并展开证据、Comparison 从既有归因派生正式决定或待核请求、Clustering 还原请求内短编号；各阶段分别维护 submission/result，Attribution 另用内部 judgment Schema 校验程序绑定后的判断。Attribution、Comparison、Clustering 的结果 Schema 均声明可选 `rewritten`，原 Agent 不提交改写内容。Rewrite 用独立 submission 接收固定槽位身份的 rewrites，并按 result 验证。Workflow 的 export Schema 不是任一 Agent 的输出 Schema，只描述加入身份、模型信息、归因评语、回溯标注和派生判决后的正式对比行；改写槽位由三个阶段各自的 `result.schema.json` 描述，聚类导出由 `schemas/workflow/clustering.schema.json` 描述。分析助手的工具输入见 [eris/tools.json](../schemas/eris/tools.json)，它不是评测提交 Schema。

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

顶层 `messages` 结构通过适配器注册表声明。当前注册 `a`（OpenAI 风格：`message` / `reasoning` / `function_call` / `function_call_output`）和 `b`（显式轮次：`user_question` / `llm_turn` / `tool_call` / `tool_result` / `final_answer`），版本配置的 `adapter` 按 id 引用；消息结构扩展见 [InputAdapter](../packages/workflows/src/comparison/adapters.ts)。适配器保持原始消息和多模态内容，不重排消息序号，不补造缺失回答。每个 `batch_id + case_id + version` 对应一份回答；相同标识出现多份回答时报告标识冲突，使涉及它的对比组失效，不擅自选择或覆盖。同批次、同 case 的问题或标准答案冲突会使受影响模型对失效；不同批次分别检查，允许标准答案不同。

会话结构 `{ meta, traces: [{ meta, messages }] }` 由[统一读取入口](../packages/workflows/src/comparison/input-record.ts)按记录自动识别，不绑定 A/B、模型 ID 或文件名，可与顶层 `messages` 记录存在于同一来源。当前只接收恰好一个 trace；空数组、多 trace、同时提供顶层 `messages` 与 `traces`、无效消息结构，以及已声明但不符的 `n_traces/n_messages` 均明确拒绝。消息按注册适配器识别；`user_question/final_answer` 可省略 role，显式轮次必须有完整 `final_answer`，不能拿中间 `llm_turn` 代替。

会话读取只生成内存中的统一材料：消息原文和索引保持不变，不重复保留整份 traces；文件回读、续跑、看板与上传使用同一入口。外层身份字段与默认批次沿用上表规则，内外层同时声明的 case、batch、session ID 必须一致；外层题目信息和标准答案优先。trace ID、模型、usage 和回答耗时取 `traces[0].meta`，缺失值保持未知，不使用会话总量补充；模型缺失时仍可读取本轮 llm_turn 的模型记录。任一层 `ok=false` 不能评测。trace 的 timestamp 不推断为 request_time 或用户提问时间。资源字段路径指向统一材料的 `meta`。已处理源文件、已接受任务及正式结果不迁移、不重评。

不按文件行号分组。本地评测集索引记录来源文件与行字节范围，只存业务标识和定位坐标，不存完整消息或问题/标准答案；预检和评测仍重新校验原始记录。登记、选择、索引存储及无效记录处理见[输入治理](usage.md#输入治理)。实际记录数、缺失版本、对比组数和跳过原因通过 `preflight` 获取。`by_batch` 按批次汇总样本数、有效回答数、归因任务数、对比任务数、跳过对比组数和输入异常数。样本数包含已识别身份但回答无效的样本；异常和跳过记录保留批次、case 及已定位输入的文件和行号，无法识别批次的异常只计入全局诊断。文档不保存随数据变化的批次统计。

## 对比组

`comparisons` 每项选择两个或三个已登记模型。三模型展开为三场独立两两比较；重复模型对只执行一次。某个模型缺失或冲突只跳过受影响的对局，仍执行有效模型对。两两任务各自随机并持久化 A/B 位置，不把一次三方排名拆成三个独立观测。可登记更多模型，再选择不同的二至三模型组；没有四方同场排名。

默认 Fast、Expert 分别比较。三模型组必须全部显式声明相同的 `comparison_tier`；两模型组只要有一方声明档位，另一方也必须声明相同档位。仅双方都未声明档位的两模型组可不设置该字段；第三方基线加入已分类组时须声明其实际档位，不能绕过公平性检查。配置保留用户选择的组，Workflow 执行时展开模型对。

同批次、case、同问题和标准下先固定共同 Criteria；一致标准可从一份输入传播，互斥标准分别规划，不让同一回答随对手切换标准。归因只有在 Criteria、标准答案一致且按当前材料通过归因校验时才复用；不一致时独立复核。候选约束集合改变需重新准备共同基准，旧接受结果及其血缘保留。

每场独立两两 Comparison 首次随机分配并持久化 A/B 位置，不代表实际版本或模型身份；导出时恢复稳定版本 ID。归因任务使用单数 `answer` 并可见真实版本身份。进入 Comparison 前，Workflow 对题目、标准答案、共同 `task_analysis`、源归因中的同一分析、原始耗时字段、归因文本和工具可读取的 trace 使用同一份去身份视图；原始来源、Criteria 收据、归因正式结果和证据不因此改写。可区分的版本、展示名和回答模型标识在文本及结构化字段名中会遮蔽；图片字节保持原样供工具查看。单字符或与业务正文混淆的简称，以及仅隐含在正文中的身份，仍需人工检查盲测要求。候选的导出顺序与候选位置不影响派生判决。

## 归因与判决

### 短链路与仅答案材料

被评模型可以只提供真实用户问题和最终答案，不要求附带推理、工具调用、SYS/DEV 或实际模型输入。输入仍须有可定位的原题和完整最终回答；最小接入示例见[第三方模型](usage.md#第三方模型)。目录只说明采集到的内容，不证明隐藏过程完整或没有执行。

结果与过程分别核查：题干、标准答案或已登记的原始事实能够确认最终交付时，正常评审正确性、完整性与核心可用性；缺少内部过程本身不记为回答缺陷，也不使整场自动待核。实际无法确认的过程条款保留 unknown/uncertain；只有影响核心交付是否完成的未知要求，才使核心状态为 null 并进入现有复核。原题明确要求交付引用、解释、计算步骤或成品时，仍检查完整答案中的实际交付；要求真实执行某动作时，仅有“已经完成”的自述不证明执行。

已确认的输出缺陷与责任定位分开保存：最终答案可确认有错，而请求、工具返回或实际输入不可见时，finding 仍可为 final_answer / established，无法定位的 component 填 []。不补造工具或把隐藏过程推定为模型推理错误；其他候选的原始事实可帮助核验结果，不能证明本方执行过工具或收到过资料。未知组件的缺陷仍保留在正式 JSONL，按已定位组件展开的聚类不替它猜测根因。资源记录缺失继续使用 null，不把短 trace 当作更快或更省 token 的证据。

### 归因与共同基准

每条回答先经过归因 Agent，以 Workflow 的 `ground_truth.available` 为准。有标准答案且能够核实时，`is_correct` 为 true/false；确实无法核实时可为 null，但 `core_assessment.meets_core` 必须同时为 null，并引用适用 requirement 的 unknown/uncertain 评审，保留待核。两种情况都须填写非空核对理由和最终回答证据；已确认的缺失、数值不等价或量纲冲突不能改成未知。无标准答案时，固定填写 `is_correct=null`、`correctness_reason=""`、`correctness_evidence_indices=[]` 和 `numeric_checks=[]`，不判断与标准的一致性。四个字段仍存在，程序校验空值并生成对应正式结果。`standard_conflict` 默认 false；提示词仅允许用原始披露或完整数据复算证明标准答案的具体错误后提出复核；独立复核还须确认同场双方最终所求结果一致，缺少任一条件均撤销标记，证据门槛见[评测质量](quality.md#流程与科学边界)。无标准答案时禁止填写。该标记与 `is_correct=false` 并存，正确性理由以“标准答案待复核：”开头，关联最终回答和冲突依据，总评保留标记及简短原因。初次标记会为同场双方各触发一次独立归因复核，使用现有 reference_materials 相互登记原始输入，不引入任一方旧判词；对比等待双方复核，改写和聚类采用对应复核后的结论；原始收据保留，撤销的标记不进入当前标准冲突统计。复核不新增 Schema 字段，不自动改变对比状态或排除统计；语义判断由 Agent 完成，程序只按结构化标记安排复核，不按点评关键词判断。`has_standard_answer` 由 Host 从请求填入接受结果。模型工具 Schema 从可信请求选择，不采用展示投影决定这些字段。归因提交安全检查可识别字段中的覆盖、作用域、无标准答案、问题描述约束及当前证据数组中的引用坐标，与结构错误一并反馈；结构错误或缺项不会遮蔽已能解析的非法引用。合并后的反馈仅按完整错误内容去重；不同候选、判据、路径或修复细节分别保留。接受结果继续使用同一套独立规则和完整证据校验。

归因模型按 `criterion_checks` 固定顺序提交 `criterion_assessments`，每项只有 status、evidence_status、summary、evidence_indices；不提交判据 ID。顶层提交 meets_core、core_reason、core_requirements，后者只选择 applies_to=[] 的共同 requirements 正整数编号，动态提交 Schema 给出允许的编号。程序绑定正式 core_assessment.criterion_ids，并为其他候选专属要求生成 not_applicable；本方专有要求仍须逐项评审，但不能作为共同核心依据。缺项或多项拒绝，不猜测对应关系。核心 false 必须由已确认的共同 partial/unmet 支持；true 不能同时选择已确认 unmet 的核心项；null 保留具体未知范围，局部 partial 不机械等于核心失败。

模型提交 strengths 和 problems 两个固定的扁平数组。每条都有 dimension、stage、importance、text、reason、evidence_status、evidence_indices 和 basis_index；problems 额外固定填写 impact、component、label、definition。没有观察时对应数组填 []，不按条目类型增删互斥字段。text 写具体行为，reason 补判断依据；问题另写 impact，优点的正式 impact 复用 reason，不要求重复表达。程序生成正式 assessment.observation。finding_basis 把适用任务要求与本方规范合为一个正整数目录，模型只选 basis_index；任务要求编号与 core_requirements 对齐，所选私规通过完整真实规范证据限制在本方；dimension 仍描述问题主题，不靠分类名称扩大共同作用域。程序绑定真实规范及 requirement，真正无关联填 null；未知规范须 uncertain。component 从本方可用责任方中明确选择，证据统一由 evidence_indices 引用，不能因引用正确来源就给来源记责。正式 findings 先保留 strengths 顺序，再保留 problems 顺序，ID 和完整坐标由程序生成。

归责依次核对请求与工具返回、模型实际输入、最终回答。answer_generation.input_contexts 提供实际回答链各轮完整输入的读取目录，不混入独立规划，也不复制正文。错误请求、计算或误读实际收到的资料归模型；工具返回有缺陷且影响答案才归工具；正确返回在实际输入中丢失或改变，归「上下文组装与传递」。实际生产交付被破坏可归「回答呈现与采集」，已证明异常的环境、权限或配置故障可归「执行环境与权限配置」；正常拒绝与评测材料缺口不构成这些故障。Agent 明确选择 component；程序从本方材料动态提供责任候选，新增两环节须同时引用本方非纯最终的实际过程与相关最终交付，规范与 peer 不能代替。校验只证明选择与证据资格，不从出处自动判责。正式字段结构不变。最终明确错误推导或算式可直接定位模型，不因缺实际输入快照留空；只有结论不符时仍不能倒推根因。缺少输入记录也不能证明模型已读到完整返回。标准答案的具体错误记录在 correctness_reason 与 standard_conflict，不制造候选 problem，不影响正确交付的核心可用性；其他独立错误仍须逐项归因。所有点评直接写实际值、标准值、具体口径或计算偏差及影响，不用“无法确认来自模型、工具还是标准口径”收尾，不把有依据的回答写成编造。其他尚未确认的问题仍可保留空责任和真实未知。被评方不可见标准答案，不能以未核对标准归责。每条 finding 的身份由程序按顺序生成；归因不读问题库、不建类，Workflow 按已确认组件展开聚类观察，不重复计同一回答缺陷。

Criteria 提交 requirements、scoring_points、red_flags 三个数组，每条只包含 source_indices 和不超过300字符的 text。text 是一个可分别核验的交付项；同一来源可以拆成多个不同检查项。模型材料只展示候选数量和来源适用位置，text 使用原题语言，不写候选身份；题中已给事实是输入条件，不自动成为复述或额外举证的义务。模型不生成判据 ID、候选 UUID、原文坐标或验收规则。程序按来源交集绑定 applies_to，按组生成 r1/f1/s1，并把完整所选原文与共用核验规则写入 acceptance_rule。原文条件、例外、单位与效力始终优先；检查短句是否忠实须语义复核，不能因引用合法就认定没有新增义务。Criteria 自查并由 Attribution 回到完整原文核对时窗、边界、日期与例外；程序不以数字白名单或比较词正则裁决条件是否保留，事件名、日期和代码中的数字不被强制解释成阈值。

question 至少支撑一条共同 requirement；私有作用域的并集不构成公共覆盖。标准答案完整保留给后续归因和对比，不进入 Criteria 可选来源，不从标准答案的中间值或补充信息生成任务要求。SYS/DEV 不进入新任务要求，已识别的内部上下文、附件容器、NER 与用户结束后的元数据块不升为交付义务；它们原始材料仍用于本方核查。三组原始提交合计最多24条，只有检查内容、原文依据和作用域都相同的项目才归并；不能按相同来源编号删掉独立验收点。正式结果继续检查来源、作用域与重复项。

已接受归因的来源视图直接核对正式 canonical 结果中每个完整 evidence_id 与原任务登记来源、消息、引文和 source 归属；图片还须对应真实图片及原查看记录。不重新执行当前提交 resolver，不重新解释 receipt.submitted、责任声明或已接受判词，不按引文搜索坐标，也不恢复缺少坐标的格式。坐标缺失、来源不符或原文不一致明确拒绝；合法结果只读投影，原收据、业务字段与累计账本不变。后续 Comparison 绑定和显式证据验收使用此视图；已持久化判词导出直接复用原行，不要求已完成任务重新读取输入或重新评测。

### 对比与定向补查

Comparison 使用两条已接受归因完成一次比较，照录各回答核心可用性；源归因的完整 `task_analysis` 须与本次共同基准相同，核对文本、作用域和验收规则。基准不一致、来源已待核或核心未知时，程序保留具体候选和既有判据，派生 `needs_review`；没有可信的确定结论时不强行判胜负。日期或数字的文本差异不自动构成事实冲突；事实与归因由 Attribution 核验，必要时通过独立核验检查，程序不抽取点评文本强制改判。来源 false 只有专有失败、没有双方共同适用 requirement 的已确认 unmet/partial 时同样保留待核；不直接改成 true。正式 core_failure_refs 仅采用共同作用域失败。Comparison 不新增或改写 finding。

Comparison 按 comparison_slots 固定顺序评审共同验收点和可比资源；关联到要求的既有 findings 放进对应行。独立 finding 保留在本方归因，不自动生成另一方空格。共同要求即使没有同名 finding，也使用各自已接受的 criterion_assessments；缺少 finding 不等于没有做到。专有要求只评本方，不参与横向优势。程序派生状态、关联与排名，只有同一适用方面的双方 established 事实才能支持优势。

首次对比前，Workflow 检查是否存在尚未关联要求的共同范围中高重要性问题；存在时为双方各准备一次归因补查，将具体观察作为待查内容，不冒充本方事实。新归因独立核查本方材料，确实涉及共同交付时关联对应要求；不强造关联。原收据保留，未开始的对比依赖新收据；每场最多一轮。独立优点保留在本方点评，不冒充单方优势，也不阻塞已确认的共同标准。补查后关键问题仍未对齐时 Comparison 保存 needs_review，不将记录缺口写成双方没有差异。双方共同核心已确认失败时，额外未关联问题保留在各自归因，不因此阻塞都差判定；核心未知、专有失败、来源冲突和基准不一致仍须待核。已正式接受的对比及可选事后核验不触发这轮补查。

主线接受 `status=decided` 的 Comparison 后形成正式对比，不自动重做归因。已知材料冲突或核心未决的样本保存待核，不计 wins/both_good/both_bad、不上传；其他样本继续。`verify-comparisons` 为已正式决定的对比准备可选独立核验，结果单独写 `comparison-verification.jsonl`，核验失败或发现疑点不撤销正式结果、不重接下游依赖。归因与对比文案默认自动润色，可显式关闭；聚类单独读取已接受归因，其结果同样默认改写。

### 提交方式与反馈

Agent 自主决定读取、检索、图片观察和计算步骤。提示词要求数值争议核算，程序不强制调用某个计算工具或按固定顺序操作。当前提交入口如下：

| 阶段 | 工具及原生参数 | 正文校验 |
|---|---|---|
| Criteria、Rewrite、Clustering | `submit_evaluation` 直接接收对象 | 阶段 submission Schema |
| Attribution | `submit_evaluation({"json":"完整 JSON 字符串"})` | Worker 严格解码对象，再由 Host 校验 submission；正文 Schema 随 `json_content_schema` 提供 |
| Comparison 可选核验 | `execute_code` 写完整 JSON，`submit_evaluation_file({"path":"相对文件名"})` | 按工具描述的 `file_content_schema` 读取文件并校验 |
| 可选核验首查 | `inspect_material({"path":"相对文件名"})` | 首查成功后才暴露最终提交工具，检查点由程序持久化 |

所有模式保留原始内容，执行严格结构与业务校验，不补写 JSON、不静默改字段或判词。Attribution 和普通 Comparison 不需要写稿文件；正文里位于字符串内部、后面不是 `,`/`:`/`}`/`]` 等结构字符的英文双引号由程序确定性转义（只插入反斜杠），修复后仍须通过全部 Schema 与业务校验，完整可解析对象之后仅剩多余闭括号和空白时，只删除这些尾部标点，不改正文、字段或数值。格式恢复次数记入收据的 `submissionStats.jsonRepairs`；第二个对象、附加字段、正文或未闭合结构不在恢复范围，其他 JSON 语法错误使用独立加载预算，不消耗内容修正次数。核验首查和最终提交共用单任务内容队列与累计修正预算；阶段额度和续跑规则见[运行与恢复](usage.md#运行与恢复)。通用 Profile 能力声明见[提示词模块](../packages/prompts/README.md)。

内容被拒绝后，Worker 在工作目录将提交快照单独保存为 `submission-rejected.json`；文件模式反馈的 `draft_file` 指向该快照，与模型自行创建的工作文件分开。文件读取、提交 JSON 解码和提交工具参数解析失败统一记入 `fileErrors`，累计三次加载错误后停止，该计数跨同任务续跑保留。加载失败不生成新草稿，保留上一份真实草稿，也不反馈不存在的草稿路径。

提交或核验首查前若仍有必读材料缺口，Worker 使用真实 `read_trace` 返回下一页原文和证据编号，并告知 `material_pending`。本次仅补给材料，不验证或接受草稿，不消耗内容修正次数；模型读完后重新判断并提交。每次从首个未读位置继续，遵守原必读预算与总期限，不把自动读取伪装成已完成评审。

校验反馈包含 `code/path/message` 及适用的 `candidate/expected/actual`。Attribution 的结构错误给出当前扁平字段的 `expected.target.path` 和 `submission_shape`；业务反馈使用模型实际可写的字段及目录正整数，不要求填写内部 ID 或嵌套对象。数组错误路径仍按 JSON Pointer 从0定位，例如 `/problems/5` 指第六条问题；它与从1开始的证据和要求选择编号分开。反馈不提供新证据或修改草稿；原 expected 约束与真实 normative_sources 保留。

每次内容失败为下一次修正提供三次额外探索调用；文件模式的保留写稿额度、必读页与探索计数见[工具架构](architecture.md#新工具)。模型使用当前工作目录的相对文件名，按实际反馈修稿。当前阶段的内容工具始终保留在可用工具集合中，不消耗探索预算。完整错误集和草稿 JSON 内容均未变化（键顺序不计）时，反馈明确指出尚未修正的重复错误；保留剩余内容额度，所有内容提交使用同一累计上限，额度耗尽后停止，不重置提交次数。证据选号不合法时反馈当前可选范围，来源不符时给出实际材料及读取入口。

真实 completed OpenAI Responses assistant 错误中，当前已注册工具的参数非完整 JSON 对象时，在同一会话反馈失败工具、当前阶段、集中工具说明和真实剩余额度；不补写 JSON、不派发参数对象。提交及 inspect_material 的无对象尝试经同一内容队列计入加载错误并保存 checkpoint，不消耗内容修正次数；读取工具消耗探索额度。事件保留 malformed_arguments 和 argument_object_available=false，不创建草稿或收据，不推断未知参数 JSON 相同。已登记证据、已有真实草稿和成功首查继续保留。未知工具、身份不符、缺终态、输出截断与连接服务错误不进入这个修正入口。

模型整回合没有提交且没有报错时，Worker 用集中提示词追加一次提交提示，仍无提交记为一次执行中断，并按[运行与恢复](usage.md#运行与恢复)中的有界重试处理。

Worker 在直接收到提交 JSON 或文件 JSON 加载成功后发出 content_loaded 提交事件，保存该稿的真实内容与累计序号；文件随后被覆盖仍可在显式 debug 事件中核对原稿。该事件不表示通过，不增加第二次内容计数；没有参数对象的 SDK 错误不制造 evaluation。Host 保存有效收据后才算完成；未接受时退出、超时或模型报错保留失败状态。

独立 Attribution 复核可以接收同场、同原问题的已登记 `reference_materials`，每份标记 `grader_only=true` 与真实 `source_input_id`。这些材料只供裁判核查事实，不构成本候选可见的系统指令。Attribution 的新模型提交不能选择 peer 的最终回答文本作为独立事实依据，包括已展示和延后的最终原文、已登记的原始最终生成块以及覆盖这些文本的 JSON 摘录；两份答案不同只证明交付不同，双方相对差异属于 Comparison。程序按已有 final_evidence、deferred_final_material 和 answer_generation 的原始坐标定位文本范围，不按整条消息号排除，同一消息中的真实工具、参考资料、时间戳和图片仍可引用。这是新证据选择的接收规则，已接受收据继续按原坐标恢复并校验来源与正式行，不改写历史判词，也不重新接受历史模型稿。所有模型材料和读取工具返回的 `reference` 统一为 `{evidence_index}`，模型只选择任务内正整数。程序目录保存完整坐标及已登记输入 UUID，据此选择唯一真实 raw，foreign 正式证据保存程序派生的 `source/source_input_id` 与该来源的 `evidence_id/message_index/quote`；模型不得另填 source。未知或重复登记 UUID、UUID 错配或不同题目均拒绝，不猜测来源。每份材料保留各自原末条 user 的 timestamp 字符串或缺失 null，peer 时间须与自身 raw 完全相同；不同来源时间不要求相等，不用对方时钟补本方时间，相对日期依据仍按本方实际上下文独立核查。跨来源原始事实可辅助判断正确性，但不能代替本方最终交付、数值 actual、链路责任或指令规范；指令闭环及共同作用域只读取本方引用。图片查看记录、表格对应、恢复与导出按证据的真实来源定位，不能拿 peer 的消息坐标解释成本方调用。未验证行可用同题 peer 的完整、独立工具返回复核，但全部本方行和已知反证仍须保留，由 Agent 解释对应关系及差异。

### 两两判决

两两判决由排名与核心判定派生，不单独判定：

| 情况 | 派生判决 |
|---|---|
| X 完成核心要求、Y 未完成 | 判 X 胜 |
| 双方都未完成核心要求 | `both_bad` |
| 双方都完成、排名同层 | `both_good` |
| 双方都完成、排名不同层 | 层更靠前者胜 |

`ranking` 是标签按层的二维数组，最优层在前、同层并列，每个候选恰好出现一次。`task_analysis.requirements` 保留必要验收条款的完整原文，核心可用性由 `core_assessment` 另选相关条款；不把原段中的条件、例外或可选内容一律当作核心要求。额外加分项放 `scoring_points`，没有实际加分项或红线时对应数组可为空。`meets_core` 表示关键交付可用性，`is_correct` 表示标准答案一致性；局部数值偏差可判标准不符，但不自动使主要交付不可用。`high`/`medium`/`low` 描述实际影响，只有使关键交付不可用的缺陷才作为核心 high 问题。

Host 在接收提交、恢复和离线校验时要求核心不可用有适用核心要求的已确认 `unmet/partial` 事实。Comparison 的程序派生与校验共用同一规则：从来源 `core_assessment.criterion_ids` 中筛选该候选适用、逐项事实唯一且为 established unmet/partial 的 requirements，作为 `core_failure_refs`，至少一项；来源核心判据中的已满足上下文保留在归因中，不计入失败引用，未被核心判据引用的缺陷也不自动加入。来源核心可用或本次待复核时该数组为空。正式判决的 `meets_core` 必须为布尔值并与源归因一致；待核实的 null 只能进入复核。可用性按整份最终交付判断，不机械绑定标准对错或 importance，Comparison 仍不能改写归因。排名必须是候选的划分，全部不可用候选同层且在可用候选之后；双方可用时，仅一方有已确认的中高重要性优势则不能并列。都差仅用于双方关键交付均不可用，都好仅用于双方可用且没有实质差距；不设置数量配额。还检查 `assessments` 覆盖全部候选、决定性发现引用既有归因 finding。这些检查不代替事实和影响判断。离线校验按源文件流式读取登记记录，行号变化时按业务标识重定位，不将整份 JSONL 载入字符串；读取期间文件变化会拒绝该来源。

模型侧 task_analysis 仅呈现当前归因候选或本对比较至少一方适用的条款；归因选择编号为原全局位置加1，不按过滤后的列表重新编号；程序将 applies_to UUID 转为 applicable_candidates 标签，不要求模型自行解析身份。恰好重复的 acceptance_rule 仅在展示时省略，正式标准保留完整原文。比较材料中的归因不重复镜像整份 task_analysis，可信请求与正式结果仍保留全局原标准；过滤不改判据、编号或最终覆盖。

Comparison 原始 summary、tradeoff，以及可选核验的 observation、concern reason、concern_matches.observation、source_reviews.reason 没有任意字符上限；完整取舍和反证不能因展示长度被拒绝。非空、引用、作用域、重复选择、覆盖及有依据的取舍仍严格校验。可选核验首查成功后，Profile 的 `inspection.materialContext` 提供程序根据本任务首查生成的 `verification_concerns` 和数字 `eligible_match_choices`；机械覆盖提供选择资格，不证明实际行为与责任相同。这些上下文不写入正式判决。

Comparison 提交顶层 a_summary、b_summary、同序 comparisons、可选 preference、必填 relative_preference、a_tradeoff 和 b_tradeoff。普通非空行只有 importance、可选 better_candidate；逐格点评直接呈现本方本判据已接受的 summary，以及关联 finding 的 text/impact，完整文本去重、不添加新解释。资源行只提交 importance，双方文案与优势方向由可信指标生成；没有 assessments/A/B 子对象。只有 optional 槽可填 null。Schema 限定行数，目录给出适用范围与 advantage_candidates，业务校验严格检查优势资格；不为每行复制整份子 Schema。模型不提交 status、ranking、criterion_ids、finding_indices 或 decisive_findings。程序回填正式关联、状态、核心失败引用和排名；材料冲突、核心未知或未对齐的关键观察保留 needs_review。

正式 `result.schema.json` 保持原有 decided/needs_review 结构。程序生成每行 aspect、criterion_ids、双方 finding_indices 与状态，不能因模型少抄 ID 丢覆盖。scope=source_only 的槽不能用于相对优势或决定性依据，任何维度引用私有规范都继承该边界；错误关联共同题目不能扩大私规范围。未绑定标准的 finding 若对方没有已接受的同方面事实，保持 unknown/uncertain，不能借“对方没有 finding”确定优势。uncertain 不能加强为 established。资源优势只使用双方共有的同种有效指标：完整耗时须双方均为有效非负值，token 须双方均为有效非负安全整数，总量冲突已在输入归一化时置空；缓存等其他字段异常不否定有效总量。程序在一方所有共同有效指标不劣且至少一项更少时派生该方优势；指标互胜、相等或没有共同有效指标时留空。缺失/冲突的单项不比较，也不补零。token 不等于费用，单次时延受环境影响；任一方存在有效耗时或总 token 时，资源槽必须保留；模型视图提供 resource_metrics、comparable_metrics 与程序派生的 advantage_candidates，程序逐项展示耗时与总 token 的绝对值，缺失或异常显示无有效记录；Agent 只评重要性，不编写资源行文案或优势方向，不额外推算百分比。相似数值仍展示，低影响差距不据此强行判整场胜出。双方核心状态决定通过/失败分层；双方均可用时，整场胜出由显式 preference 和该方已确认的中高共同优势共同支持，不从单项优势自动生成赢家。独有中高优势却未选择整场偏好时退回修正，差异影响不足则降低 importance，确有实质优势则明确 preference；仅有低影响差异不能产生正式胜者。全部未达标候选保持同层；都好、都差均在 tradeoff 明确一方有依据的相对倾向，详见[评语标准](quality.md#评语标准)。comparison_scope 和既有归因是比较依据，模型不新增 finding、改写归因或让 Attribution 修改排名；可选独立核验记录来源疑点。

### 可选独立核验

Comparison Workflow 默认每对仅计划一个 default 节点；接受的 decided 结果直接进入 `comparison.jsonl`。累计内容预算见[运行与恢复](usage.md#运行与恢复)。显式 `verify-comparisons --run PATH [--result ID] --apply` 从已接受正式对比准备新的可选 verification UUID，并保存只包含这些核验任务的 executionScope；预览不修改状态、不调用模型。核验复用主线源收据及完整材料，不重评已接受归因，不替换正式对比。可信请求的 comparison_draft 是主线只读结果；首查隐藏上游 findings、met/core、评审和排名，先看原问、标准、真实时刻、最终交付、来源及适用要求。核验结果进入 `comparison-verification.jsonl`，不参与胜负、交付或问题库。

可选 verification 通过 inspect_material 提交首查 JSON。按 verification_check_slots 固定顺序填写每条适用规则的 delivery、constraints 两个子槽，提交 result、source_evidence、observation；程序绑定候选、规则和完整最终交付审阅范围，模型不手填 answer_evidence。子槽合并优先 contradicted、unverified、supported，全部 not_applicable 才表示条件未触发。contradicted 须保留同一本方要求的具体 concerns；unverified 不被当作确定事实。concerns 使用真实零起始 requirement_indices 和数字证据选择；未入共同标准的本方私规用空数组，须有完整本方 SYS/DEV 与实际交付双证，不借他方、工具提示或元数据补规范。完整规范的条件、例外、全部叶子、延后正文与图片读取均严格校验；审阅范围不证明具体语义结论。Host 保存 canonical 检查点及读取审计，成功后揭示完整既有判词；首查与最终提交共享累计内容预算和串行队列。证据目录先由 Host 持久化，重发沿用 UUID 与载荷；恢复直接重验 canonical 检查点和原坐标，继续揭示后核验，不重新盲查或回退计数。

揭示后核对已有 problem、采用的 strength 和比较格。准确对应本方 established problem 的发现用 concern_matches 选择 concern_index、finding_indices 并说明同一行为及责任链；同 criterion、相似标签或机械范围交叠不足以证明匹配。资格按同一输入 UUID、原消息、真实文本路径或 JSON 物理覆盖范围计算；本方真实工具返回可佐证事实，查询参数、用户复制、元数据或他方材料不能代替。私规匹配须保留同一完整本方规范和实际回答；空 criterion_ids 仅匹配本方 requirement_index=null 的 instruction_following established problem。最终提交 concern_matches 与 source_reviews 两个必填数组；后者只列真实需要更正的 {slot_index, candidate, reason}，没有额外疑点填 []。slot_index 是 comparison_slots 的零起始位置，candidate 须在 reviewable_candidates 中；重复、越界或不适用选择拒绝。准确记录的问题和核验通过的结论不重复提出。程序保留未匹配的已验证 concerns，复制只读主线结论或派生 needs_review 核验记录，不改排名、点评、核心状态或归因；疑点不自动创建归因或后续对比任务。


模型侧 `comparison_slots` 给出方面、纯文本标准、来源观察、适用候选标签与 pair/source_only 范围，数组位置由程序绑定，不要求复制 canonical ID 或索引。覆盖由程序固定，缺/多槽按固定行数反馈 Schema 错误；独立图片/全文读取缺口仍同时反馈，依赖结构的检查等待合法结构。优势反馈指向可提交的 better_candidate 和对应 summary，不要求修程序关联。verification 尚未成功 inspect 时反馈下一动作 inspect_material；成功 checkpoint 由 Host/Worker 恢复，不能由模型创建或修补。结构和坐标通过不证明 observation、事实支持、归因责任或取舍正确，必须继续独立语义核验。

## 问题库与聚类

Workflow 的 `prepareClusteringJob(runs, config, { inputIds, assignmentOnly })` 可显式选择一组输入，先从 checkpoint 筛出这些回答的归因任务，再只解码相关收据；来源 run 的其他执行范围不改变这组选择。同一回答的接受结果按接受时间取最新，指定输入缺少已接受归因时明确报错，不静默缩小样本范围。该入口不读取原始回答、不修改来源状态，也不创建归因或对比任务。

普通主线默认关闭聚类。`cluster --run PATH ... --run-id ID --apply` 创建独立聚类作业，固定所选 run 的已接受归因引用，不复制原始回答或归因正文，不修改来源 run。主线归因及必要补查仍 pending/running 时拒绝准备，失败归因跳过并计数；聚类不依赖对比、文案改写或可选核验。冻结执行范围包含归因任务时，只选该范围内的回答；仅含改写或可选核验任务的范围不缩小聚类来源。同一模型、日期、case 在多个来源重复时选接受时间最新的一份；相同时间按排序后的来源及任务遍历顺序确定，预览记录排除与重复数量。续跑重读固定 task/submission/evaluator 与输入坐标，缺失或不一致直接报错，不静默换成新的归因。

独立作业先按模型汇总所有日期，再以组件、名称及完整定义精确聚合观察，跨日期支持次数一起计数。新计划先按原责任组件分桶，每桶按涉及的不同回答数分片，默认每片最多 30 条回答，单次归类不混合不同责任组件。Agent 必须按每条观察自身的定义与原因逐项匹配，不能因编号连续或名称前缀相似而成段归类。普通归类请求只带本次涉及组件及其别名匹配的完整类目录和样本，活跃类数、组件数及余量仍按整个模型计算；末尾全目录整理保留完整库。同一观察不因 `maxCasesPerTask` 拆开，因此一个高频观察可超过该数值但仍只给最多三条示例。同一模型的责任桶及分片串行，已接受决定先持久化、再幂等应用问题库，下一片读取更新后的目录并按当前余量计算新增预算；不同模型可并行。每个有观察的模型最后增加一轮全目录近义类整理，只允许合并与维护，不允许无观察建类；整理后把本作业仍延期的观察按最终目录再匹配一次。这次回捞设置 `budget.assignment_only=true`，程序拒绝新增、合并及目录修改，防止回捞继续扩类。显式 `assignmentOnly` 作业全程固定目录，只归类，不另做目录整理。目录维护不会自动重分已经归类的旧成员；收紧类边界、发现错配或建立更具体的类后，应选取受影响成员运行固定目录重分类，并回查实际归属，不能只改定义就宣称旧样本已修正。类名描述具体可观察缺陷，不用“事件回应”“回答质量”等主题或任务名代替问题。类名与定义使用完整名称，禁止保留本次请求的临时目录编号（如“归C19”或“框架缺项（C5）”）；有明确业务含义的型号、证券代码与错误码保留原文。已保存作业沿用原任务身份和范围，续跑不重新分桶。选定范围内有普通定向复核或其他归因 pending/running 时拒绝聚类，防止读取待复核的旧结果。Agent 请求用 `batch_ids` 表示所选日期。独立作业结果契约见 [clustering-job.schema.json](../schemas/workflow/clustering-job.schema.json)，进度单独引用结果文件，保留每个任务的累计尝试与内容提交次数。

Clustering 模型材料与提交使用请求内短编号：观察为 O1、O2…，问题类为 C1、C2…（跨组件连续编号），组件为 P1、P2…。assignments.item_id 使用 O 编号，已有类归属使用 class_label 精确填写当前组件中的完整类名，由程序解析为正式结果的 class_id，避免模型记错临时目录编号；同名类按原观察组件区分，未知名称或别名直接报错。语义匹配须同时满足类定义中的错误动作和触发条件，不能把口径有歧义当作执行不一致、把缺少核验当作事实已错，或忽略已有事实、日期等专类的边界。日期类只按其实际定义承接：来源日期或报告期转述错误、查询窗口参数错误、日期先后及日历判断分别匹配；仅有日历判断类不代表所有含日期的观察都应归入该类。closest_existing、merges.into/from 与 class_updates.class_id 使用 C 编号；组件选择仍填写名称。新类用 `assignments.new_class_index` 选择本次 `new_classes` 数组中的位置，从 0 开始；声明无需填写 key，程序生成正式结果中的 `new_classes.key` 和 `assignments.new_class_key`，不靠名称关联。同组件没有活跃类时可省略 closest_existing，程序填 null；存在候选时必须选择该组件最接近的 C 编号，缺项只反馈实际候选。Agent 在渲染材料时建立同一请求的映射，提交后精确还原真实身份，再执行组件、预算、重复归类及合并校验。未知编号或数组位置直接报错，不模糊匹配 UUID 或类名称；同一尝试的校验反馈使用相同短编号；新尝试或续跑重新根据当前材料选择，不回放上次的草稿和错误编号，避免库刷新后编号串位。正式结果和问题库继续保存原始持久化 ID，短编号不作为跨请求身份，也不写回问题库。

问题库是每个模型一份的跨 run 知识库（`data/problems/<version>.json`），由 Clustering 规则维护。每条已接受聚类决定记录：`assignments` 把每个观察（归一化 `component + label` 加完整 `definition` 精确聚合的同一描述）归入已有类或新类，或以 `deferred_reason` 记录受预算或最少支持数量限制的延期；`new_classes` 声明新类的 `component/label/definition` 以及同组件最接近的已有类和 novelty 理由；同组件无已有类时 closest_existing 为 null，`merges` 把同一组件下的近义旧类合并到保留类。疑似和已确认观察都交给聚类；类别按现象复用，不为确定程度另建类。聚类请求给出两种出现次数及示例的 `evidence_status`，库中每个出现样本保留自己的 `evidence_status`，不将疑似样本冒充为已确认。相同问题名可分别属于不同工具组件；观察只可归入同一组件内的类（已有组件的别名等同于该组件）。写库顺序是先合并、再明确维护类目录、再建类、最后落出现样本；每个出现样本保留 `class_id`、`evaluator_version`（归类收据的版本；原归因版本见归因结果行）、`batch_id`/`case_id`/`version`/`input_id`/`run_id`/`task_id`/`submission_id`/`finding_id`、消息位置与源文件行号，不保存证据摘录，可从问题类反查到样本、再回到原始数据；合并保留 `previous_class_id` 与 `class_merged`/`occurrence_moved` 事件，被合并类的 label 与 aliases 追加到目标类。物理出现记录按 `(class_id, input_id, finding_id)` 幂等。新独立任务以 `assignments_replaced` 事件记录每个 `(input_id, finding_id, component_id)` 的最新有效归属；重新分配或延期会替代该组件下的旧归属，保留历史记录和其他责任组件。有效投影按最新事件选择样本；重复 report、续跑或重放早先收据不会恢复旧归属。

归因责任树读取每个模型问题库的正式 `components/classes/occurrences`，按责任组件展示已归类问题及其样本。问题库可另存引用型待观察池 `pending_observations`，结构见 `schemas/clustering/pending-observations.schema.json`。每条引用保存原 Attribution 收据、输入与 finding 身份、源文件行号、原责任数组、重要性、证据状态和简短问题描述，不复制证据正文；同一 `(input_id, finding_id)` 只能引用一次，来源模型必须与该库一致。

Clustering 的 `replacePendingObservations` 公开入口严格校验并替换待观察引用，追加只记录数量和来源 run 的 `pending_observations_replaced` 事件，保留既有正式类和出现记录。独立作业接受决定后同步更新所处理发现的待观察引用，并保留范围外引用。新的独立作业自动带入同模型中责任已定位的旧待观察发现，将原 Attribution 引用冻结到 `clusteringJob.recall`，与新样本一起汇总支持；来源收据、finding、责任或证据状态缺失或变化时直接报错。责任未定位的发现保留待观察，不由聚类补做归因。待观察引用不创建问题类、不改变责任或以下正式类预算、支持门槛与统计。

数量由程序硬控，提示词只做引导：

- 评测内显式开启的聚类按模型×批次分片，计划期将类与组件余量均摊到全部分片；独立作业按模型串行分片，每片使用当前问题库余量。绑定任务时均按实际观察到的未知组件数收窄 `max_new_components`；
- 提交必须覆盖全部观察且只归一次，`class_id` 必须是库中活跃类，新类必须被至少一个观察使用，支持度取所归观察的 `established_answer_ids` 并集且达到 `minSupport`；疑似发现和同一回答的多个 finding 不重复增加支持度；此门槛只限制新类，复用已有适用类不要求本批达到最少支持数。原 `count/established_count/uncertain_count` 继续记录发现条目数；
- 同一组件内，`新类 label` 归一化后命中活跃类 label 或 alias 时直接拒绝，要求复用该 `class_id`；
- `活跃类 − merges + new ≤ maxClassesPerModel`；新组件只能来自本任务观察到的组件，并受 `maxComponentsPerModel` 限制；
- 每次归类都检查相关同组件近义类；达到 `consolidateAt` 时扩大整理范围并输出 `merges`。合并不增加当前任务的 `max_new_classes`，腾出的预算在后续规划时重算。
- 写库按模型锁住读、合并、校验和保存；不同 run 共享同一模型时不会互相覆盖。所有模型的上限校验通过后才写文件；若有模型超出 `maxClassesPerModel` 或 `maxComponentsPerModel`（例如并发 run 或手工下调上限），本次报告不写入任何模型的库，并提示调高上限。

独立作业的样本 `run_id/task_id/submission_id` 指向聚类决定，`clustering_run` 保存该作业目录，`attribution` 保存原 run 路径、run/task/submission 与评测器标识；`batch_id` 始终是原样本日期。原归因和当前聚类的身份分别可查，来源复核按这些引用回到原 Attribution source scope。

问题分类按“责任组件 → 问题方向 → 具体问题”呈现，模型作为切换维度和导图根入口，不计入问题分类层级。新建类和显式维护的 `category_paths` 只填写一个问题方向，形如 `[["指令遵循"]]`；全目录整理必须为每个保留类指定方向，不增加第四层。请求可以读取已有目录的路径，整理时显式改为一个方向；每级填写简洁的单行纯文本名称，禁止 ASCII 标记分隔符 `< > [ ] { }`、C0/C1 控制字符及 Unicode 换行分隔符 U+2028/U+2029，允许普通中英文、数字、emoji、括号、斜杠和破折号。无效名称按具体层级原样返回错误并要求重新填写，不自动清理。Agent 提交与正式结果、请求中的现有目录均校验；应用目录收据时再次校验实际创建、待应用的更新及合并后的最终路径，拒绝污染写入。已应用更新按原幂等规则跳过，复用已有类时不提交新路径；被跳过的整理更新不能替代合并最终路径的校验。不重验未变更的旧目录或改写历史收据。现有目录中缺失或空数组表示未组织，合并时没有可继承路径则保留该状态；新建类和显式更新路径必须给出一条主要路径，不能显式清空。模型侧方向区分指令/计划遵循失败、意图—计划错位、无效调用、数据与工具输出误解、虚构或无依据的信息、计算与逻辑错误、结果表达与交付。用户意图欠明确、能力不支持与正常护栏触发本身不自动构成错误；只整理原归因已确认的不当处理。聚类先固定观察的责任组件，从已有归因中提取该组件的直接错误；同一发现共同归责时，工具返回问题与模型使用问题分别归类。模型选错工具、请求参数或调用顺序不记作工具自身故障；请求正确而返回错误或缺失仍属于原归因记录的工具组件。工具类只概括其返回或执行缺陷，不把模型未核验、未补取或错误断言作为类的必要条件。明确的日期、对象或指标错配优先匹配错误返回专类；成功返回但缺字段或覆盖与超时、连接失败分开，后者沿用可见系统故障，不推测上游原因。新建通用类须排除已有日期、阶段、数值、转写、查询条件等专类的范围，以剩余共同错误动作定义新类。相同直接错误在不同模型使用相同方向：违反指定工具入口或调用约束归无效调用；遗漏明确的分析、内容或表达顺序要求归指令/计划遵循失败；已生成产物的引用、呈现或文本破损归结果表达与交付。全目录整理同时检查抽象类名，必要时通过 class_updates 改为具体对象与错误动作。方向不建立新类身份或推断根因，观察的责任组件和证据确定程度保持不变。类定义只概括行为与适用边界，不新增未证明的成因、禁令或输出义务，不固定严重程度、核心可用性或胜负。类目录不是事实证据。合并后存在不同主要路径时必须明确整理目标类，最终最多保留一条主要路径。

`class_updates` 只维护当前活跃类的可选 `label/definition/category_paths`，必须有 `reason`，不修改组件或历史归因。`class_updated` 事件保存修改前后元数据、理由及 run/task/submission 身份；按 submission 与 class 幂等，重放旧维护不能回滚后来的维护。长期名称和定义不能用当前请求 O/C/P 编号解释含义，真实业务型号和错误码保留。

延期不是失败或已归类，不写类或出现样本，观察与理由仍保留在正式聚类结果。评测 run 内的显式 `recluster --task ...|--all` 创建新 UUID 任务，只重新处理尚未被后续任务承接的延期观察，并用当前目录及扣除其他未完成任务预留预算后的余量规划；原收据及本轮提交次数不变，不自动跨 run 重试。独立聚类作业在目录整理后自动进行一次固定目录回捞；仍未归类的发现留在待观察池，后续扩量作业自动带入。续跑沿用已规划任务与接受决定；显式重聚类使用新作业 ID。问题库统计与主题展示按 `(input_id, finding_id)` 计算独立缺陷数，多组件和多主题仍保存全部关联。

显式历史来源复核请求见 `schemas/clustering/occurrence-review.schema.json`，通过 Workflow 的 `reviewProblemOccurrences` 公开入口先沿原 Clustering 的 input 依赖重建 Attribution 观察，精确核对该组件下的 input_id、finding_id、原 source 位置、消息、原文和 evidence_status；原接受 item 与实际 assignment 必须对应这个观察及原问题类，同组件 merge lineage 可以解析到当前类，不能用同名的其他 finding 或无关类替代。text/json 证明只收完整当前自包含 evidence_id，每项至少有 owner 原材料证明，可附加原归因 source scope 中的 peer 证明；拒绝独立 source、图片证明和原 source scope 之外的输入；坐标由 Tools 重读，操作理由是显式来源审计判断，不能把坐标有效声称为程序已经验证语义。默认 preview 没有写入；模型库锁等待后二读原 Clustering scope、items/assignment、全部 Attribution 依赖的 owner/receipt 和登记 inputCatalog，原来源发生变化则拒绝。apply 使用同一个模型库锁追加 `occurrence_rejected` 事件；事件 UUID 与决定一一对应，重试同决定不新增，复用 UUID 改决定直接报错。

事件 detail 保存 evaluator_version、原决定及每个目标的 occurrence UUID、`input_id/finding_id/component_id` 关联、复核时 class_id、原 Clustering run/task/submission 和原 Attribution task/submission。原 occurrence、accepted、类 UUID 和 lineage 保留；有效投影排除该关联的所有物理行，跨同组件合并、续跑或重放旧收据均不能复活。多组件只撤明确错误项，剩余有效组件仍保留独立 finding 计数；多主题不会重复计数。默认类内样本列表在去重、排序和分页前统一过滤，总数与页面行使用同一集合。类/组件数量与硬 cap 不变，目录边界另用 class_updates 维护。

该维护不是新的 Agent 判词，也不自动按 uncertain 状态或类名撤销，不改归因责任或恢复被撤关联。apply 只追加问题库事件，不调用 reportRun，不回写运行状态、正式结果、历史报告、stats 或 statistics-log；后续正常报告的当前库 occurrences 使用有效集合，而 assigned/new-class/merge 决定数保留已接受收据的行为账本。外部统计上传结构保持冻结。

失败的聚类任务不写库；其他已接受任务的归类保留，原问题仍保留在来源 run 的 `attribution.jsonl`。

## 改写

整场偏好理由以60–100字为表达目标，优先保留决定结论的事实与限定；不因超长机械拒绝，不截断句子，也不改动判决。

改写配置为 rewrite.attribution / rewrite.comparison / rewrite.clustering，三项默认开启，可显式设为 false；归因、对比及后置聚类接受后自动把结论润色为更简洁规整的表达。归因初次规划一个占位任务，源结果接受后才确定语义分组；对比和聚类各规划一个改写任务。对比默认只改偏好理由，comparisonItems=true 同时加入普通逐项点评；资源行由程序生成，不进入改写，也不接受改写回填。改写只接收文本槽位、不接触证据或改变判决；自动化为完整交付仍强制开启归因、对比及逐项点评改写，见[自动化](automations.md)。

- 对比裁判继续盲测；Workflow 仅在改写前将槽位称谓还原为真实组别与模型名称（如 A组Fast、B组Fast），本地收据和 JSONL 的槽位 id 保留盲测位置。对比槽位的只读 context 同时提供完整候选身份映射，供 Rewrite 理解原文中仍保留的候选称谓；程序不匹配普通字母猜测身份。Rewrite 沿用真实称谓，本地展示按源任务映射回填。Mongo 交付另将候选槽位映射到 `versionA/B` 的展示位置，见[上传身份映射](automations.md#mongodb-增量交付与每四小时日志)。
- 归因润色总结、正确性理由、核心完成理由、逐项检查、发现点评与理由、观察与影响、问题名称与定义及表格核查理由；问题描述的改写只用于展示，聚类始终读取被接受的原始归因。当前改写投影只保留源结果当前提供的槽位，历史收据不变，导出、报告和看板使用同一投影。
- 核心点评槽位以“回答对用户请求的满足情况”为用途，并附只读 context 限定验收对象：方法或步骤类请求评价回答是否给出可执行方法，不代表用户已经实施；用户要求执行时才沿用原文的执行结果。无法保证语义、验收对象和限定不变时保留原文，不从用途说明新增要求或判词。
- 归因按语义分组请求：总结、核心完成和正确性理由一组，全部判据点评一组，每个 finding 独立一组，全部表格核查理由一组；每组最多20槽，超限只在本组内继续拆分，不跨 finding 合并。未尝试的占位任务复用 UUID 作为第一组，其余组追加新任务；冻结试跑只将同一来源回答的新增组加入原执行范围。已接受文案保留，显式刷新按同一分组创建新请求；旧未接受请求全部槽位被后来请求覆盖时保留任务与提交账本，在独立归因作业中不再派发。
- Rewrite 的模型侧 label/text/context 将 ASCII 尖括号显示为全角符号，保留标记名称、属性值、数字和既定判断；正式请求、源结果、id、preference 与 forbiddenPrefixes 保持原值。展示替换不代表原回答使用全角字符。提交 text 仍须为字符串，对象不会转换为文字。
- 输入是 Workflow 选定的文本槽位（模型可见 `items[].id/label/text/context`）及 case 的批次/case ID 或聚类的批次/模型定位信息，不含原题、原始消息、证据和 finding 引文；模型看不到可用来重新判断的材料，只能润色。
- 模型提交 `rewrites: [{id,text}]`，与请求同序、同数量；动态提交 Schema 通过每个位置的 `prefixItems` 和 `id.const` 固定槽位身份，Agent 再校验正式槽位及偏好，收据和内嵌 rewritten 保留同一身份。各槽分别改写，只能去除本槽重复表达，不能把不同槽位的内容合并、互换或省略；真实组别与模型称谓、事实相关的数字与单位、限制条件和不确定性原样保留；裁判无关的自评打分/置信度分档可以删除，不拿用户指令充当具体优点。
- 对局偏好改写必须以真实胜者名加“更好：”、或“双方都好：”“双方都差：”开头；程序校验该前缀与已接受判决一致。都好、都差均保留 Comparison 在 `tradeoff` 中确定的相对偏好、依据及反向优势，正文保留“更倾向某方”及依据。两类槽位还携带已确认的低影响单方优势，供润色保留细微差异；Rewrite 不自行数问题或选边，不改变排名、赢家字段或统计。当前文案按收据接受时间逐槽取最新值，同一接受时间按任务清单次序后者获胜；未触及槽位保留此前文案，重放旧收据不回滚新文案。`rewritten.evaluator_version` 取最新接受的改写收据版本，每份历史收据仍保留并独立校验其原始版本和完整评价；被覆盖的历史文本通过状态差异记录恢复。
- 显式逐项改写只请求 `comparison.<行号>.<候选>.summary`；本格原文放在 `text`，同项对照和已确定的本项优势放在只读 `context`，不含证据；不把对照信息复制为点评前缀。Workflow 通过 `forbiddenPrefixes` 指定不可作为前缀的呈现标签，Rewrite 校验拒绝复制标签，避免将本项赢家名称贴到另一方事实前。每格先写具体得失，保留局部优势、各自约束与不确定性；仅更新这些槽位，已改写偏好、方面名、优势标记和引用保持不变。
- 定向修复在任务数据中保存 `rewriteSlotIds`，请求必须与该非空、无重复的已知槽位集合完全对应；未知槽位在派发前拒绝。`executionScope` 保存本轮任务 UUID 清单；成功任务及其他范围外任务不会进入请求；同 run 冻结范围时不发现新增输入。准备修复保留既有源结果及文案，接受后只合并请求的槽位；旧成功任务的 attempts 和判决版本不随修复变化。CLI 选择与释放范围见[使用指南](usage.md#只补失败与同类故障熔断)。
- 正式结果不变：`attribution.jsonl`、`comparison.jsonl` 保留裁判被接受时的原文；`ranking`、`meets_core`、`is_correct` 和证据不因改写变化。评测 run 的改写附在对应阶段结果的 `rewritten` 字段：归因为 `evaluation.rewritten`，对比为 `rewritten`，聚类为 `result.rewritten`（内容为 `evaluator_version` 与 `rewrites` 槽位文本）。独立聚类作业将槽位文案保存到 `results/rewrite.jsonl`，以 `source_task_id` 引用原聚类结果；两种工作流均不单独记录改写业务日志。
- 看板同时展示原始输出和改写后内容，聚类详情在运行总览。问题库的类身份、归属与原始定义不被改写覆盖。看板按聚类收据及对应 Rewrite 投影通俗类名和定义；后续语义维护使不再对应的旧文案失效。
- `report.md` 与 `task_summaries.md` 优先展示改写文案，离线校验仍以正式结果收据为准。导出保留完整已接受原文与改写，名称展开不另设点评字数上限。
- 完整对比改写续跑时按源结果实际保存的槽位补缺，只请求缺失文字并合并回填，已有文案和源评测保留；接受后的补缺或显式定向刷新新增 UUID，相同来源、范围和槽位的未完成任务复用并保留已花提交额度。交付校验检查该源全部当前改写任务及缺失槽位，历史已接受任务不能掩盖尚未完成的刷新。
- 普通续跑可以开启或关闭改写：已接受的改写保留，未完成且被关闭的改写任务不再计划；显式固定范围内按已准备任务执行，不重新规划开关。已接受的评测结果不受影响。

## 证据与导出

对比结果 JSONL 和逐题总结 JSONL 的每行都以 `request_time`、`has_standard_answer` 两个顶层字段开头，其后是产出该行的 `evaluator_version`。`request_time` 取该组第一个版本（按 `comparisons` 声明顺序）的输入原值，缺失时为 `null`，不受盲测标签影响；`has_standard_answer` 为布尔值，表示本题是否有有效标准答案、是否进入归因的对错判定，与 `ground_truth.available` 一致。

### 证据编号与原始坐标

模型可见材料与工具把原文及定位信息同 `reference` 选号对象分开。归因用 evidence_indices 数组或 numeric_checks.evidence_index 直接选择编号，图片观察单列 image_observations 的 image_number/text；独立核验仍用 `{evidence_index}` 引用对象，图片可附 observation；编号是本任务从 1 开始的正整数，未知、非整数、越界和额外引用字段均拒绝，不自动选择或替换材料。程序用同一同步登记 helper 维护 append-only evidenceBank：同一完整坐标复用编号，新的坐标只追加；目录不存原文、引文、observation 或哈希。初始材料、已实际返回的 read/search/table/image 页及核查成功后揭示的程序材料使用同一目录；原始消息值、真实股票代码和脚注标记保持不变。

完整 EvidenceReference 与 evidence_id 仍是程序的公开坐标契约：`ev_<登记输入 UUID>_<消息索引>_<text|json>_<起>_<止>_<路径>`，图片为 `ev_<登记输入 UUID>_<消息索引>_image`。Host 按当前任务实际绑定的来源校验目录及引用，保持来源、归属、原文范围、规范闭环和图片查看证明的现有要求，再展开正式结果的 evidence_id/message_index/quote；数字选号不证明语义正确。索引、路径或起止范围无效时拒绝，不会从错误坐标猜测引文或把越界范围改成整段；模型反馈提供可选编号范围及对应材料，不返回完整坐标供抄写。优先复用同候选、同消息的实际读取记录，长片段以 `quote_preview` 展示开头并标记 `has_more`，其 `reference` 仍指向完整已读片段；没有合适证据时按 `read_request` 继续读取。读取、搜索和展开共享公共工具包中的字符串/JSON 表示，不进行其他模糊匹配。可引用消息内的原始字符串，也可引用该消息按两空格缩进显示的 JSON 连续片段，包括结构化工具返回的字段和数值；`search_trace` 同样支持查找这些片段，scope=tool_returns 只查原始工具返回并从新到旧排列，默认 all 保留全部消息范围；命中附带 read_request 供补读完整字段，分页须保持范围与查询词不变。独立核验的图片引用选择 `reference.evidence_index` 并附 `observation`；归因从 `image_observations` 绑定同一图片的观察，正式结果展开为 `[图像观察]`，工具审计必须存在实际 `view_image` 记录。Host 校验引用、索引和判决关系，事实判断仍需[质量复核](quality.md)。

### 材料投影与来源目录

初始材料是渐进式披露的首屏：`initialContextChars` 专用于证据材料，原问、最终回答与完整规范另行展示，不挤占该预算。`initial_material` 先按最终引用放入预算可容纳的完整来源块及原始坐标，同一引用优先使用真实工具返回；没有对应原始返回时才使用模型实际可见的来源。剩余预算先放真实工具返回，再补充调用与模型过程消息，同类按新到旧选择；剔除大体积 `input_messages` 与模型参数，证据引文同样计入预算。来源块原样展示为 value 字符串，完整消息保留原对象；不摘要、不拼接片段，不以引用关系替代真实性判断。实际回答链上的 system/developer 单独放入 `instruction_sources`，完整保留原文，不在首屏消息中重复；程序沿最终回答对应的 LLM 输出及其真实 assistant 历史提取嵌套指令，排除工具规划器上下文。Criteria、Attribution 与 Comparison 的可信来源和正式规范保留原始字节及完整坐标。盲测只作用于模型展示与工具返回：Host 将可序列化 presentation 传给 Worker，工具在按原文分页和登记证据后脱敏展示文本、移除消息身份字段；ID、路径、分页偏移和图片字节不变，完整坐标始终解析原始输入，不建立展示坐标映射。`final_evidence`、`initial_material[].evidence`、`instruction_sources`、`citation_inventory` 和 `table_check_results` 的生成证据目录使用引文与 `reference` 展示；原始消息值中的同名字段保持原样，不递归改写。`read_trace` 可用 `path` 选择原始文本或结构化字段（对象、数组、数字、布尔值、null），省略或空字符串时读取整条消息 JSON 并给出文本路径目录。目录偏移 source_offset=0 是无作用的默认值，可与正文 path 同传；非零目录偏移不能用于具体正文路径。字符串使用原文本坐标，结构化字段使用其在整条消息 JSON 中的真实坐标；分页 offset/next_offset 始终相对于所选字段，模型不计算证据坐标；`source` 标明当前坐标来源，分页保持来源不变并使用返回的 `next_offset`。`read_trace` 和 `search_trace` 在 `maxOutputChars` 内分别缩短原文页、减少检索条目，始终完整返回配对的引文与 `reference`，不交给通用字符截断；其他工具超预算时仍截断并将完整内容存为可分页产物。

任务判据目录只选择本轮用户交付要求和真实候选用户约束，SYS/DEV 不整份升为任务判据或共同优势。内部指令仍完整保留在本方材料中，由 Attribution 和独立复核按真实指令层级、触发条件与实际行为单独核验；未入 requirements 的私规用 source_only finding 与完整本方规范和实际交付证据闭环，不能借共同问题扩大作用域。

Workflow 用原整组去身份映射及当前候选真实 system/developer/user 完整规范块，匹配 criterion.acceptance_rule 中程序保留的原文；检查短句 text 不作为来源绑定依据，保留标题、正文、跨文本叶子条件和例外，不按近似含义或中文标点拆义务。`criterion_instruction_sources` 保留真实 evidence_id、消息、路径及完整原文；criterion_assessments 仍按该关联将完整规范放入 context_evidence，模型须另选聚焦的实际交付或执行证据。Attribution 的公开 `attributionNormDirectory(request)` 先按原 requirements 顺序列出本方适用且有可信真实规范绑定的项，再列未被这些项完整覆盖的本方 SYS/DEV 与未关联 USER 原块；目录只做物理来源分组，每项为 `norm_index / roles / requirement_index / evidence`，跨角色的真实规范束保留全部 roles。当前请求必须提供 `answer.norm_directory`，启动模型前与真实来源严格比较内容和顺序，未知来源不借 peer 补造。

模型只看到统一的 finding_basis；选择一次 basis_index 后，程序绑定目录中已有的规范与任务要求关联，不读文字猜关联。strengths 与 problems 的固定行都使用同一个目录；分类为格式或证据质量等仍保留所选规范的本方作用域，不扩大共同义务。所选完整规范只作为来源，不证明条件触发、遵守或违反，不改 status/core；未选项不自动补入，正文或 reason 不用来猜关联。完整原规范已由真实 instruction_sources.content、同坐标 initial_material.value 或可信 criterion 原文展示时无需再次工具读取；只有真实隐藏或截断的选中长块须完整 read_trace。

每条 finding 均须显式选择直接支持结论的证据；final_answer 必须含本方真实最终正文或已查看图片，非最终阶段引用真实执行片段。correctness、逐项评审和 finding 优先引用最小充分片段，连续推导、完整表格行或多来源核验需要上下文时保留完整引用。长度是呈现建议，程序不因单条或整组字符数拒绝提交，不截断引用；真实来源、原文坐标、阅读记录及结论所需证据仍须通过校验。`table_resolutions` 须引用完整最终行与全部既有来源行，按表格完整性规则验收，不能用裁剪或遗漏来源解除疑点。程序不自动追加最终回答，所选完整规范独立放入 findings / criterion_assessments 的可选 context_evidence，保留原条件、例外和精确坐标；它只用于规范解释与作用域核对，不能代替实际交付、数值或责任证据。规范上下文也须验证真实来源；Comparison、独立核验、恢复和模型展示保留它，直接证据标注只使用 evidence。遗漏判断须完整审阅相关范围，在观察中说明检查范围与缺项，再引用相关章节或结尾定位；程序不把短片段认定为全文缺失证明。

超长最终正文从初始 final_answer 展示中省略，不向原文插入占位符；deferred_final_material 提供 read_request，持续沿 next_offset 读至原文终点，图片也须实际查看。聚焦引用不缩减阅读门槛。程序按 strengths 后接 problems 的顺序生成 f0、f1 等本回答内 ID。已接受 canonical 收据按原坐标直接恢复，不重新执行新提交的聚焦规则，不添加证据或改变历史判词。

新提交中高影响 problem 关联有效适用 requirement 时，不能同时声明该条 established/met，改 problem 为 uncertain 也不能绕过；不影响该项验收的低影响附属错误可以与 met 共存，不能为通过校验而降低真实影响；partial/unmet、判据 uncertain 和真实无关联仍保留自身语义。私有规则不扩大共同核心作用域，程序不代判违规或核心可用性。

`citation_inventory` 定位最终回答引用的完整来源块，记录实际 footnote/trace 编号、vis-html 资源 ID、引用位置、来源与 resolved/ambiguous/unknown 状态；trace ref 对应 serial_number/ref，trace anchor 对应可追溯工具的 action_id，按真实属性匹配。vis-html ref 只匹配真实工具返回或实际模型可见工具消息里的同 ID 资源对象，包括 stdout JSON，不从技能文档示例或仅含 ID 的正文构造来源。一次工具返回可有多个来源 ID；模型可见上下文新增的 serial_number 单独标记 model_visible，不冒称原工具返回。

每条 occurrence 保留原标记证据并附 context：同一真实文本叶子内、以空行分隔的连续原文段落及其引用、read_request 和 end_offset；无空行的表格或长段落保留整体，不拼接其他叶子，也不自动划定语义主张。状态只描述是否能定位来源，不证明整句支持或最终渲染。支持粒度按本回答真实引用协议及相邻标注组核验，可由同组多个来源共同支持事实或段落，不自创单个编号必须证明全部分句的要求；第三方协议未知时不强套本产品语法或主张粒度。操作或文件 anchor 的范围还须核查对应真实调用、取得的文件与可用全文，不把 stdout 摘录缺值直接等同文档缺值。

模型视图中超过200字符的来源与上下文展示 quote_preview、has_more、真实整段 reference、read_request 和 end_offset；来源块已完整展示在初始材料时直接核验，否则按返回 next_offset 补读到来源终点。来源歧义不猜选，未知不直接判伪造。数值、单位和实体语义核对使用等长遮蔽后的引用标记视图，原文、偏移和正式证据保持不变，注脚编号不成为指标值或实体名称。

正式证据必填程序 evidence_id，并保留同坐标解析得到的 message_index/quote；规范 context_evidence 保留各原始叶子的完整坐标，与直接支持判断的 evidence 分开。Comparison 直接投影这些坐标为 reference.evidence_index，不从引文反查重复位置；超过200字符时提供预览、read_request 和 end_offset。来源、路径、范围及原文不一致即拒绝。证据覆盖只按真实范围；JSON 覆盖文本须实际包含该完整叶子的序列化范围。最后模型生成与捕获回答只有真实生成链及完整有序文本叶子逐字相同才允许同范围对应，不根据偶然相同文字或图片未知状态推断支持、渲染或责任。

Attribution / Comparison 的 `modelInput.task_focus` 先展示原问、`task_analysis.goal`、真实 `ground_truth` 和每条回答的定位。可见 `final_answer` 不超过16000字符时整段复制，超过时只保留原 `final_message_index` 与 `deferred_final_material` 目录，不截取局部。`question_timestamp` 取原始最后一条 `role=user` 消息的 timestamp 字符串，缺失或非字符串为 null，不解析自由文本或使用评测时钟。null 只说明原生字段缺失，其他可见时钟仍须从原始上下文核验，不能借缺字段断言没有时间依据。focus 的共同要求按 Criteria 完整候选作用域检查，保留 id、全局 `requirement_index`，1000字符以内的 text 完整复制，长文留在完整材料。归因模型视图的 `task_analysis.requirements` 每条显示对应原数组位置加1的 `requirement_index`，保留原 id/text，作用域改以 applicable_candidates 展示，重复的 acceptance_rule 仅在展示时省略；不按本候选适用列表重新编号。focus 与索引只用于呈现，可信 request、正式镜像与证据不新增字段。

模型选择未知、非整数或越界证据编号时拒绝提交，反馈给出当前可选编号范围；不自动补选证据。已解析的证据不符合来源、交付或规范要求时，`expected.suggested_evidence` 保留真实短引文；已登记的坐标重用 `reference.evidence_index`，新建议只给实际 `read_request`，完成读取后才分配编号。拒绝反馈及恢复错误呈现不增加目录，避免 HTTP 拒绝中的临时 audit 分配未持久化编号。模型先核对片段是否支持原判断再选择，不将建议直接视为已接受证据。程序内部的完整坐标仍严格校验，不猜测无效路径或范围；对象与数值路径的建议使用真实 JSON 片段，无效路径没有建议引文，读取请求退回原消息以定位真实字段。

### 正式导出与资源指标

每条对比行给出 `ranking`、`assessments` 与派生的 `verdicts`（键为本场两个稳定版本 ID 组成的模型对）。三模型组保存三条独立两两对比行，每条只有两个候选；`models / assessments / evaluations / attribution_task_ids`、逐项对照和决定性发现均按本场稳定版本 ID 关联，允许第三方 ID，不依赖固定 A/B 身份。`evaluations` 保留归因的标准一致性、可选 standard_conflict、数值与表格核验、逐项与核心评审、发现及完整证据。派生判决使用 `win` / `both_good` / `both_bad`，后两种的赢家字段为 `null`；`verdicts[].reason` 原文是程序生成的规则概述，改写槽位则结合逐题事实直接解释偏好；具体差异与反向事实来自 `decision_basis.tradeoff`、候选评估和归因 findings 中。评语中只有明确的 `【候选A】` 等候选标记会按盲测映射替换为展示名称；其他正文及证据原文保持不变，不根据普通字母或业务词语猜测候选身份。每个模型对的双方胜场之和、都好数、都差数相加等于有效比较数；每个模型的参战数还包含败场，失败任务与待核不计入这些分类。

归因任务使用单份 `answer`。有标准答案的 `correctness_evidence` 至少包含其 `final_message_index` 对应的最终回答，可追加本方真实工具返回、规范、执行材料或已登记 peer 的原始事实作为佐证；所有坐标逐条验证，peer 不冒充本方实际交付。正式 `numeric_checks.evidence_index` 由程序转换为 correctness_evidence 内部位置，所指实际值证据仍必须来自本方最终回答。无标准答案时模型仍提交规定空值，正式结果保存空的正确性证据与数值表。正式归因行包含 `task_id`、`submission_id`、`input_id`、`case`、稳定 `version` 和 `evaluation`（判对结论、理由、展开的原文证据）；评语不做盲测标签替换。结果文件位置与恢复规则见[运行产物](usage.md#运行产物)。

`stage` 表示发现属于上下文回溯、推理、执行或最终回答；`stage_trace` 由程序从原始消息生成，包含工具、位置、置信度与来源。只回溯当前 finding 引用的证据；无法唯一定位时保留候选工具，不猜测确定来源。

Agent 初始材料的 `original_answer_timing` 只提供 `finish_seconds`（完整回答完成耗时，秒）；登记信息仍保存原始首 token、首段与完成指标供追溯，但首段时刻不代表最终答案可用。`original_answer_usage` 从被评输入 `meta.usage` 提取输入、输出、总 token 和缓存输入，记录来源字段、总量依据及数据异常。A 的 `input_tokens_details.cached_tokens` 和 B 的 `cached_read_tokens` 统一为 `cached_input_tokens`，它是输入子集，不重复累加；未记录总量且输入、输出都有效时才相加。缺失或无效指标为 `null`，总量冲突与缓存超出输入会标记异常，不使用裁判 SDK 消耗或累加 trace 快照。直接上报总量与有效输入加输出均用于比较本次总用量，取得方式或缓存字段名不同不构成口径冲突。耗时和 token 分别用于等待与资源效率判断；资源逐项点评保留两项数据，整场取舍按候选分别追加程序生成的资源记录，模型不复写数值或拼接候选身份。报告沿用已接受结论，不重读来源来重评。

逐题总结包含问题、要求、判决、同项对比理由、各方优缺点、得分点、red flags 和原始回答体验对照。逐项使用可比数据，未知指标不填零；token 量不等于价格，单次耗时不代表长期性能。

### 数值与实体核验

数值目录只提供标准原值与上下文，不根据候选写法用正则分配语义目标。百分比与百分点、点值与边界等含义由 Agent 根据完整原题、指标定义和证据解释；需要推导的目标在 correctness_reason 核验。数字相同不证明语义正确。

程序仅从可信 `ground_truth` 提取 `numeric_references`，按来源顺序提供从1开始的模型 reference_index、保留标准原精度的 expected 和完整来源 context；支持正文、结构化值和标准表格中的多个数值，排除可识别的证券代码、日期及编号。模型的 `numeric_checks` 只提交 label、从1开始的 reference_index、actual、scale、mode 和直接指向证据目录的正整数 evidence_index；程序绑定标准原值 expected 并计算 matches。工具返回或自算值不进入标准目录，目录为空时提交 Schema 要求 numeric_checks=[]；补充事实继续按原来源核验并写在 correctness_reason 或 finding 中。正式结果及 comparison 的 evaluations 保留 expected/actual/scale/mode/matches/evidence_index，不保存 reference_index。

expected 由程序保留标准原有小数位与科学计数法指数，actual 保留最终回答的数值及方向；明确的万、亿计数允许等价十进制写法，例如454.54万辆对应4545400辆，此时scale=1。程序必须在所选原文范围及该单元格自身表头证明数值等价，不接受近似反推或换用其他数值。提交端 actual 可为字符串、有限且不丢失整数精度的 JSON 数字或 null；程序将数字明确转为正式字符串，保留负零；scale 须为字符串。非有限值、不安全整数和最终回答不存在的数值拒绝。程序使用十进制整数运算记录算术观察：rounded 按标准末位精度四舍五入，exact 精确比较，离散计数使用 exact。未交付的目标填写 actual=null，程序生成 matches=false，并引用支持缺项判断的最终回答，不以0占位。matches 不与 is_correct 或核心状态强制绑定；Agent 必须根据原题、双方原值、单位定义、未舍入计算和实际影响说明正确性，不能将二次舍入或展示精度差异自动判错，也不能无依据豁免真实偏差。提交安全检查和正式验证共用算术与证据规则，无关结构错误不遮蔽非法标准选择、实际值或可确定的换算错误。

[单位校验](../packages/agents/src/attribution/units.ts)回到原最终消息定位引文中的数值，读取邻接单位、该单元格同列的明确单位表头，或该表紧邻前一段落声明的单一单位，不因引文裁去单位而跳过。列单位优先，表级声明不跨表或跨无声明段落，也不用于日期、代码和编号列。天、交易日、个交易日按计数核对，明确的日期坐标不当作计数。仅在两端单位明确、唯一且同维时，程序校验 scale 是否符合已知倍率。未知单位、复合单位、同值多义及需密度等条件的换算，由 Agent 在 correctness_reason 依据原文和计算解释，不因单位词典未覆盖而拒绝，也不能随意选择倍率。质量与体积、百分比与百分点等语义差异不能仅凭数字相同忽略；其是否导致答错由完整证据与任务要求确定。

模型须逐项填写可直接比较的同口径点值目标，单一目标也不例外。原题或标准明确给出容差、区间、上限或下限时，按原条件核验该目标，不将中心值或边界套成点值相等；该目标不入数值表。最终回答仅以分数、名单、图表或需额外条件的表达交付，须计算或解码才能比较时，也在 correctness_reason 保留原规则、实际交付、过程和判定，并引用 correctness_evidence，不伪装成逐字 actual/expected，也不当作缺项。最终回答已直接给出的计算结果仍可按原值入表；日期、代码按原任务核验。单一及多目标的比较方式、抽取和覆盖均须语义复核，程序不根据标准文本形似单个数值强制添加表项；它严格验证已提交表项的标准绑定、原值证据、数值格式、明确同维单位的倍率及算术结果，不以数值表强制覆盖语义判词。目录为空或没有直接点值目标时提交空表，混合情形保留其余直接点值目标；数值表通过不代表整份判断正确。

原文数字匹配保留数值边界与方向：识别明确的“跌”及下降表述、量词前的单字中文数量（包括天与交易日，不包含日期中的“日”）、完整公式中的减法右操作数；紧接半年、季度或月份标题的年份不并入前一小数。数值未出现在引用时，反馈附上实际解析的 quote，并列出当前证据目录中包含该原值的编号；没有可用编号时要求先读取完整片段，不把模型填写的 observation 当作原文。

[表格来源核对](../packages/agents/src/attribution/table-review.ts)为可解析的最终代码/名称表预计算 `answer.table_check_results` 并由 Workflow 提供给归因；summary 统计全部行，rows 仅展开经证券代码规范化后的疑点行及真实证据。目录只识别带表头分隔行的标准 Markdown；JSON 行、stdout 空格表、Python 字典打印等不自动成为来源表。没有可比来源表时，实际回答行保留 unverified、原文坐标和空 sources，不虚构匹配或冲突；未收录也不证明原材料没有支持或反证，须继续读取真实来源。模型直接检查疑点与两侧原文，按对象、时间和加工过程解释差异；归因直接复用预计算结果并用 read_trace/search_trace 补读原文，不再提供重复的 check_table 调用入口；表格核验与提交时的重算检查保留。提交校验从原始消息重算，拒绝预计算材料缺失或不一致，不把计算完成声称为模型逐行阅读。conflict/ambiguous 只表示字面差异，不强制制造 problem 或拒绝提交；Agent 引用两侧原文解释语义；尚未核实的范围在归因中保留未知，不将文本匹配状态直接当作语义结论。输入侧 `source_review` 是程序生成的只读事项目录，每项包含 `kind/reason/requires_review`；kind 区分 unverified、unresolved_conflict 和 invalid_material。requires_review=true 的事项要求 Comparison 输出 needs_review。unverified 不能单凭来源缺失判答案错误；未断言具体代码的文字占位符仍按任务要求评审。六位证券代码相同且仅一方省略 .SH/.SZ/.BJ 后缀时可对应；交易所后缀按大小写统一识别，两边明确不同交易所不能合并。

表格匹配目录只辅助阅读。unverified 与 unresolved_conflict 均保留具体提示，requires_review=false，不按匹配状态、问题数量或双方胜负组合硬判待核；Agent 仍须阅读原文核验。invalid_material 表示来源材料重算或校验不一致，requires_review=true，继续阻止正式比较。归因核心状态为未知时，Comparison 仍按既有核心判定保留待核。

归因首轮及独立复核均可用可选 `table_resolutions` 逐行选择本方完整表目录的正整数 table_index，提交零起始 row_index、outcome（supported/conflict）、reason 和 evidence_indices；程序还原正式 table_id。只接受预计算中的疑点行，每行一次；已匹配行不能提交解除决定，证据须覆盖完整最终行与全部既有来源行。supported 还须引用非代码执行工具返回的完整来源文本或已列出的来源行；Agent 根据原文说明全称简称、大小写、对象、时点或修订关系，程序不使用肯定句正则代替语义判断。未知行不能用回答或自编代码输出自证，输入参数和元数据不充当返回证据。conflict 须有同时引用两侧原文的 established problem；finding 可聚焦同一真实行内被比较的代码、名称单元格，完整行由表格材料及核验引用保留，不要求在 finding 重复长行。仅写解释或省略已有反证不能解除疑点；仍未查清的事项沿现有复核流程保留未知。

### 文案校验

偏好改写通过 `preference` 锁定既定对局结论前缀；都好、都差正文均可保留原裁决的相对偏好。是否忠实保留主体、取舍、共同可用或失败边界由语义复核确认，不以正文关键词代替判决。责任定义明确根因未定位却列组件时退回修正。这些检查只拦截明确矛盾，不能取代真实题集的语义复核。聚类的未知编号或跨组件归类反馈使用本次请求的短编号，不自动更正或猜测归属。

改写硬校验槽位完整、唯一、文本非空、既定偏好前缀及 Workflow 指定的禁止前缀。`validate --require-rewrite` 对所需范围的全部已保存槽位应用当前机械契约，不只检查最近一次改写收据中的子集；语义复核单列为 required。简洁长度、数字保真及正文是否忠实表达判决由提示词引导和结果复核，不按“更好”等关键词判断胜负，不因数字集合变化或超长触发结构修复；这些机械检查不证明事实正确。

归因的每条 strengths/problems 都明确选择 basis_index 或 null，不再提交 requirement_index 或 norm_index；是否能使用所选规范仍按真实来源和维度校验。普通 Comparison 的 better_candidate 和 preference 可省略，分别表示没有本项相对优势声明与整体胜出偏好；relative_preference 必填 A 或 B，都好、都差据此生成明确的相对倾向前缀，a_tradeoff/b_tradeoff 分别填写本方取舍依据，不写候选称谓、他方事实或资源数值；程序绑定主体并追加可信耗时与用量，非平局时沿用胜出方。相对倾向不改变 ranking、核心状态或正式赢家，不提供“无偏好”选项。普通行仅提交重要性与可选优势，资源行仅提交重要性；逐格正文直接取已接受事实，不由模型重述。可选 Verifier 的 source_reviews 只提交真实疑点的非空索引选择，理由绑定本方已有要求或 finding，资源或不适用格不能请求修改来源。Schema 不完整不隐藏可独立判定的引用、数值槽或来源范围错误；同一修稿反馈一次列全，派生条件不成立时不追加噪声。
