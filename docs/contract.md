# 数据与评测契约

[返回首页](../README.md) · [使用指南](usage.md) · [Schema](../schemas/README.md)

本页维护跨阶段语义；字段全集和必填约束以 Schema 为准，模型动作以 [Prompts](../packages/prompts/README.md) 为准。模块职责见[模块地图](modules/README.md)。

## 唯一规则来源

| 内容 | 实现 |
|---|---|
| 输入、身份、分组 | [input.ts](../packages/workflows/src/comparison/input.ts)、[adapters.ts](../packages/workflows/src/comparison/adapters.ts)、[input-record.ts](../packages/workflows/src/comparison/input-record.ts) |
| 阶段请求、提交和结果 | [schemas/](../schemas/README.md)、[Agent 公开入口](modules/README.md) |
| 材料绑定与正式导出 | [binding.ts](../packages/workflows/src/comparison/binding.ts)、[schema.ts](../packages/workflows/src/comparison/schema.ts) |
| 报告与回溯 | [report.ts](../packages/workflows/src/comparison/report.ts)、[annotations.ts](../packages/workflows/src/comparison/annotations.ts) |

### 评测器版本标识

`evaluatorVersion` 是配置中必填、人工维护的判词来源标识；更新要求见 [AGENTS.md](../AGENTS.md#当前契约优先)。状态、Schema 和内部协议不设版本号。

收据保存接受时的评测器标识和实际判官模型 `judge`；正式行的 `evaluator_version` 必须与收据一致。改写另存 `rewritten.evaluator_version`，统计汇总 `evaluator_versions` 与 `judge_models`。同 run 可混合版本：已接受结果不变，未完成任务使用当前配置。

## 输入与输出的分层

| 层 | 含义 |
|---|---|
| 原始输入 | 数据源中的 JSONL，由适配器解析 |
| Agent request | Host 组装的可信材料，用于 Schema、引用及业务校验 |
| modelInput | 可选的模型展示投影；精简与去身份不改变 request |
| submission | 模型返回的选择与判断 |
| result | 程序绑定身份、展开证据并接受的结果 |
| Workflow export | 加入业务身份、源任务引用和派生判决的正式 JSONL |

| 阶段 | 材料与职责 |
|---|---|
| Criteria | 原题、公开用户要求与统一质量规范；定义共同交付边界，不接收内部指令、标准答案、候选回答或普通工具轨迹 |
| Attribution | 一条回答、公开基准、可选标准答案与过程事实；核对正确性、逐项事实、核心可用性、优点和问题，不读问题库 |
| Instruction Review | 已接受主归因对应回答的 SYS/DEV、已确认加载的 Skill 与实际行为；独立检查条件、例外及遵循情况，不接收主归因结论 |
| Comparison | 两条已接受归因、共同基准、完整标准答案与候选材料；核对既有 finding 的事实支持并确认同方面差异，程序派生排名与判决，不改归因 |
| Rewrite | 指定文本槽位与必要表达上下文；只润色，不接触原始证据或改判 |
| Clustering | 归因问题观察与本模型问题库；归类、建类、合并和维护目录 |

## 输入

每条回答由 `batch_id + case_id + version` 唯一标识。文件名和目录只组织来源，不定义批次或样本身份。

| 字段 | 规则 |
|---|---|
| `batch_id` | 顶层 → `meta.batch_id` → `inputs.default_batch_id`；命名评测集的缺省批次见[输入治理](usage.md#输入治理) |
| `case_id` | 顶层或 `meta.case_id`；同时存在时必须一致 |
| `version` | 来源配置确定；记录声明时须与配置名称一致 |
| `request_time` | 缺失或 null 合法，非空字符串原样保留 |
| `has_standard_answer` | 可选布尔值，不代替真实标准正文 |
| `messages` | 原始消息及多模态内容，顺序是证据坐标的一部分 |
| `meta`、`trace_id` | 采集状态、标准、模型、资源记录与追踪信息 |

标准读取 `meta.ground_truth / meta.std_answer`；同题有效候选的非空标准须一致，可共享其中一方提供的标准。`ok=false`、无法解析或没有完整最终回答的记录不参评。重复身份、题目冲突或标准冲突只使受影响对局失效，不任取一份。

工作台清洗入口会补齐 `meta.info` 中的业务标签、按 RUED 计算完整精度 `meta.difficulty_score` 并补缺失的 `meta.difficulty`，同时规整毫秒耗时与 `usage`。既有难度冲突、非法可选指标写入清洗报告，不因此排除有效回答；`ask_time` 不作为请求时间。字段优先级与未知值规则见[标签与效率清洗](../server_dashboard_ths/docs/metadata.md)。

适配器 `a` 读取 OpenAI 风格消息及 GPT 采集的 `span`（`reasoning` 元数据，以及带 `output` 的 `thinking` 或 `tool-*` 记录）；工具 span 的输出参与证据导航，`reasoning` 元数据和思考 span 不作为工具返回，不改写原消息或证据坐标。`b` 读取显式轮次，两者与模型厂商无关。统一入口也接受 `{meta,traces:[{meta,messages}]}`，当前要求恰好一个 trace；多 trace、与顶层 messages 并存、计数或身份不一致均拒绝。不重排消息、不拼造最终回答。外层题目与标准优先；模型、trace、耗时和 usage 取本 trace，缺失不以会话总量补齐。

原始消息中的 `role: null` 表示未记录角色；生成 Agent 请求的 catalog 时省略该可选字段，保留原始输入及证据坐标，不推断或补造角色。

原始输入只保留在数据源。运行、索引、续跑及文件变化处理见[使用指南](usage.md#输入治理)。

## 对比组

每组选择二至三个已登记模型；三模型展开三场独立两两对局，重复模型对只执行一次。某模型缺失只影响含它的对局。

三模型必须声明同一 `comparison_tier`；两模型只要一方声明档位，另一方也须相同。仅双方都未声明档位的两模型组可以省略。Fast 与 Expert 分开。

同题先固定 Criteria；共同基准和标准一致、来源通过校验时复用单回答归因，条件改变则独立复核并保留旧收据。扩组后比较实际判据内容和标准，并校验来源证据；变化时独立复核，不覆盖已接受收据。各对局随机持久化 A/B 位置，导出恢复稳定版本 ID。去身份包含稳定 ID、配置名、展示名、记录的模型名及其大小写变体，统一作用于评测展示及读取工具，代码工具可见的 inputs/ 文件同样匿名化；内部原始来源、证据坐标和图片字节不变，引用以读取工具返回的原文坐标为准。隐含身份仍需人工检查。

## 归因与判决

### 短链路与仅答案材料

真实原问和完整最终答案即可接入，不强制提供内部推理、工具或 SYS/DEV。结果能够核实时正常判断；隐藏过程保持未知，不能把未采集视为候选缺陷或推断更快、更省。

确定的答案错误仍须给出最可能主责；过程不完整时将责任标为inferred，分别说明关键缺口与替代解释，不降低已经成立的缺陷确定性。原题要求执行、引用或交付成品时仍须核对实际交付；“已完成”的自述不证明执行。

### 归因与共同基准

Criteria 提交三组 `{source_indices,text}`：requirements、scoring_points、red_flags。程序生成 ID、来源交集作用域和含完整原文的 acceptance_rule。同一来源可支持多个独立检查项；三个数组中作用于全部候选的共同项去重后合计5–12项，私有项不计入共同数量，全部项最多24项。数量在提交解析及正式结果校验时检查，不自动填充。原问与质量来源须由共同 requirement 覆盖。SYS/DEV与已确认加载Skill不进入共同基准和主归因，统一由后置独立指令检查处理。公开要求的数量、必交范围、可选性与例外按原文保留。标准答案不进入 Criteria 来源目录，完整保留给 Attribution 核对事实。

Attribution 按固定 criterion_checks 顺序提交逐项判断；程序绑定判据。核心选择只引用共同 requirements 的正整数编号。核心 false 须有 established 的 unmet/partial 支持；局部 partial 不机械等于整体不可用。整体未知可与局部已确认事实共存，理由须说明未知范围。

普通 Comparison 可用 `source_reviews` 提交决定性来源疑点，每项选择已有 `slot_index`、该槽 `reviewable_candidates` 中的 `candidate` 并说明 `reason`。程序绑定该候选原判据和 finding，保留 `needs_review`、空排名和空决定性引用，不改变归因。非空复核禁止同时提交正式或相对偏好；资源槽、不适用候选及重复选择均拒绝。双方门槛不一致继续用 `scope_conflicts`，同槽不重复提交两种复核。此入口约束已识别的语义风险，结构校验本身不保证模型能识别所有误读。

`is_correct` 表示标准一致性，`meets_core` 表示关键交付可用性，两者独立。有标准时提供核对理由和本方最终回答证据；无法核实正确性时核心也保留未知。无标准时提交固定空值：`is_correct=null`、空理由、空正确性证据和空 numeric_checks。

预测重评复用这套核对，正式 Comparison 增加成对出现的 `evaluation_purpose: "prediction"` 与 `prediction` 元数据，记录原任务、run、比较 ID、题目 ID、提问时刻和适用目标窗口。完整事后标答和来源保存在 `ground_truth`，只核验适用的明确预测结论，不以单次事件证明概率准确；多目标逐项说明，全部命中才判整体正确。判据仍来自原题，原回答和证据坐标不改写。自动入队、原位上传与统计替换见[预测类自动评测](automations.md#预测类自动评测)。

strengths / problems 为两个固定扁平数组。每项用 `basis_index` 选择适用要求或本方规范，无合适关联填 null；没有关联不自动降低事实确定性。问题额外给影响、责任组件、名称和定义。程序生成 finding ID 与正式证据，按 strengths 后接 problems 的顺序保存。

责任沿请求、工具返回、实际模型输入和最终交付定位。模型误用工具与工具自身错误分开；正确返回不证明模型实际收到。呈现、上下文或环境责任须有本方过程与交付证据。来源坐标合法只证明可定位，不证明责任或语义成立。

已采集但尚未读取的材料不能记为未采集，先补查能区分候选原因的相关片段。缺陷确定性与责任确定性独立核验：URL、标题或异常数值只能提示待核状态时，缺陷仍为 uncertain；将责任标为 inferred 不能把推测的外部状态变为已确认事实。核心完成须有可独立支撑原目标的剩余交付，不能仅因已有结论或如实说明能力限制就判完成。

`standardAnswerReview` 默认关闭；开启后才允许 standard_conflict 并最多触发一轮双方独立归因复核。原始直接反证是提请条件，复核还须确认双方所求结果一致。保留原收据，采用复核结果；标记不自动改胜负或排除统计。语义门槛见[评测质量](quality.md#流程与科学边界)。

### 对比与定向补查

主线每场一次 Comparison，**不自动补查归因**。定向复核、标准答案复核和事后核验各有显式入口。

Comparison 按 comparison_slots 固定顺序选择 importance、普通格可选 better_candidate；整体提交 a_summary、b_summary、可选 preference、必填 relative_preference 及一段完整 tradeoff。取舍先说明决定性差异，再解释实际存在的重要反向事实为何不足以逆转。逐格点评、状态、关联、核心失败引用和排名由程序从已接受归因派生。

普通 Comparison 对尚未统一、且可能改变核心可用性、正式胜负或使主胜因失效的共同口径冲突，提交可选 `scope_conflicts: [{slot_index, reason}]`。reason 说明双方口径及受影响的结论。索引沿用已有零起始 comparison_slots，只允许共同 criterion 槽；程序派生双方现有来源复核请求，结果为 needs_review、空排名，不改源 Attribution。非空冲突时不得同时给出正式或相对偏好；重复、越界、资源与私规槽均拒绝，importance=low 不能绕过已提报的关键冲突。普通质量差距、等价表达或不影响独立充分胜因的局部瑕疵不进入该入口；不可靠的次要理由不作为优势，保留限制后可继续裁决。识别及影响判断由同一次 Comparison 调用负责，程序只约束来源与状态转换。验收分层见[三层验收](quality.md#三层验收)。

横向优势须来自共同适用、双方 established 的同方面事实。没有同名 finding 不等于另一方没做到；私规不参与共同优势。核心未知、基准不一致或已知材料冲突保留 needs_review，不进入正式胜负、都好、都差或上传。双方核心均已确认失败时，额外未关联问题不阻塞都差。

### 提交方式与反馈

| 阶段 | 提交入口 |
|---|---|
| Criteria、Rewrite、Clustering | `submit_evaluation` 直接对象 |
| Attribution | `edit_json` 维护草稿，`submit_evaluation_file({path})` 提交 |
| 普通 Comparison | `submit_evaluation({json})` 传完整 JSON 字符串 |
| 独立核验 | `inspect_material({path})` 保存首查，随后开放文件提交 |

Rewrite 当前提交 `rewrites: [{id,text}]`，数量、顺序与 ID 由请求的动态 Schema 固定。其他阶段编号及字段约束以各自 submission Schema 和 Profile 为准。

结构与业务校验保留原稿，错误反馈提供 code/path/message 和适用的 expected/actual，指向模型实际可写字段。必读材料不足先返回真实补页，不消耗内容修正；加载错误与内容修正分别计数，累计规则见[运行与恢复](usage.md#运行与恢复)。只有 Host 保存有效收据才算成功。

探索耗尽后的预留写稿额度只用于提交 JSON：execute_code 必须在 outputs 声明 JSON 产物，未声明时不执行，也不消耗该写稿槽位；edit_json 可直接保存草稿。探索期的只读提取和复算仍按原额度计数，提交文件名与实际写入文件须一致。

Comparison 字符串解析只允许确定性转义特定内部引号、移除完整对象后的多余闭括号；修复计入 jsonRepairs，仍须通过全部校验，不补字段或改判词。实现与边界测试见 [Runtime](modules/README.md)。

### 两两判决

| 核心可用性与排名 | 判决 |
|---|---|
| 仅一方可用 | 可用方胜 |
| 双方不可用 | both_bad |
| 双方可用且同层 | both_good |
| 双方可用且不同层 | 排名前者胜 |

双方可用时，正式胜者须有显式 preference 和已确认的中高影响共同优势；仅低影响差异不产生胜者。正式胜者与 relative_preference 同向；都好、都差通常仍给相对倾向，但不改变并列判决。仅完全等价且没有可确认差异时允许 relative_preference=null，材料未知不能用无偏好代替待核。决定性引用必须来自实际支持胜者的比较项，核心失败只引用共同作用域的已确认失败项；不按问题数量投票。赢家可以有缺点，重要反向事实须保留；引用检查通过不证明语义公平。

### 模型行为归因摘要

Workflow 从当前有效 Attribution 派生 `model-behavior.jsonl`，按 `input_id + finding_id` 去重，互斥计入模型独立责任、模型参与的混合责任、其他已知责任、未知责任或未确认问题。混合责任计一次，保留组件和原收据引用；明确复核链使用最新已接受来源，即使历史对局仍引用旧归因，旧问题也不再计入当前责任汇总；未完成复核不抹掉旧结论。无替代关系的冲突保留来源并降为未确认。

这是产品判决之外的责任说明，不把产品输赢折算成模型能力，不把没有已确认模型问题解释为模型更强，不把所有优点归功于模型。该辅助产物不修改正式导出或冻结统计契约。

稳定性实验的 `validation.json` 独立保存条件、覆盖、缺失与探索性统计；`execution.tasks` 覆盖全部原计划任务，包括未派发任务，并记录当前状态、尝试数、失败、等待依赖与执行范围。`paused_stages` 和 `stop_reason` 分别说明阶段保护暂停与全局预算或截止停止；`history` 指向统一 `log/runtime.log`，当前任务快照不代替历史尝试。实验中的 `model-behavior.jsonl` 仅取基准归因，重复实验不累加成新的模型问题；这些辅助产物均不进入生产统计。

### 可选独立核验

`verify-comparisons` 为已接受正式对比准备独立任务。首查先隐藏上游判词，只读原题、标准、回答与适用要求，按固定检查槽提交事实与疑点；成功检查点持久化后才揭示旧判词。

揭示后匹配既有问题、提出确需修正的来源疑点，或以原材料反驳首查误报。匹配资格只证明同源范围，不证明同一行为与责任。核验记录单独保存，不修改主线归因、排名和交付，也不自动创建复核链。首查与最终提交共用单任务预算，恢复保留成功首查。

## 问题库与聚类

每个模型一份跨 run 问题库；它保存问题类、出现引用与 lineage，不缓存评测正文。Attribution 只描述问题，Clustering 拥有归类、建类、合并与维护。

独立作业固定所选 run 的已接受归因引用；归因仍 pending/running 时拒绝准备，失败项跳过。同一模型、日期、case 选择最新接受结果，续跑不换源。普通归类按责任组件分桶，同模型串行、不同模型可并行；每片先保存结果再更新库。末尾整理后仅用已有类回捞延期观察一次，未归类引用留待观察池。

模型使用请求内 O/C/P 编号，已有类归属填写当前组件的完整 class_label，新类用 new_class_index；程序还原持久化 UUID。反馈沿用本次目录，续跑不回放失效编号。具体字段见 [Clustering Schema](../schemas/clustering/)。

硬约束：

- 每条观察恰好归类或延期一次，只能归入同责任组件的活跃类。
- 新类支持度按不同已确认回答去重，须满足 minSupport；疑似发现不增加支持度。
- 活跃类、组件及单次新增受配置上限约束；合并不增加本次新增预算。
- 目录主要路径为一个问题方向，形如 `[["指令遵循"]]`；名称合法性由 Schema 与业务校验检查。
- 写库按模型加锁，重放幂等；合并保留原身份和事件，新归属替代同一 finding、组件的旧有效归属。
- 类定义概括可观察错误与边界，不补做归因、不推断严重程度或胜负。修改类定义不会自动重分旧成员。

未知责任不由聚类猜测；延期不是失败或已归类。统计按 `input_id + finding_id` 去重，多组件保留关联而不重复计缺陷。

显式[来源复核](usage.md#历史问题样本的来源复核)核对原归因和聚类来源，在锁内追加 occurrence_rejected 事件；只排除明确关联，保留原记录、其他组件及历史结果，不改冻结统计日志。实现见 [library.ts](../packages/agents/src/clustering/library.ts)、[problem-library-store.ts](../packages/data/src/problem-library-store.ts)。

## 改写

Rewrite 只接收选定文本槽位，不接触原题、原始消息或证据。Workflow 负责候选称谓、槽位分组、回填和展示；模型保持事实、数字、限定、不确定性与既定取舍。

整场点评的待改文本只取已接受的 `decision_basis.tradeoff`。正式判决前提与候选身份放在表达上下文，固定偏好仍由 `preference` 校验；不再拼入分项点评让改写重新选择胜因。逐项点评只在各自槽位中润色，取舍本身遗漏的重要事实应由 Comparison 修正。

整场都好／都差且源收据已给出相对倾向时，Workflow 从源提交的结构化 `relative_preference` 读取身份，将正式结论与相对倾向合并到现有 `preference` 前缀；改写须原样保留此前缀。完全等价的 null 不生成偏好，正式胜者不重复追加同向表态。不从自然语言判词反推身份，也不靠后置多数票补写偏好。前缀正确仍不保证正文理由没有漂移。

归因按概述、判据、每个 finding、表格理由分组，每组最多20槽；对比包含偏好、总评、取舍及已开启的逐项点评。资源行由程序生成，不进入改写。

原判词与证据保留，文案写入源结果的 rewritten；独立聚类作业另存 rewrite.jsonl。同槽按接受时间取最新，局部更新不覆盖其他槽，重放旧收据不回滚。失败保留原文与错误；显式 `validate --require-rewrite` 才要求选定范围全部完成。

机械校验只检查槽位、非空文本、既定偏好及禁止前缀；事实保真与表达质量须单独复核。失败保留原文和失败记录，不把无改写当成成功改写；后置审阅发现语义漂移时在实验验收中标为未通过。表达优先级为事实与主体、数字条件和确定性、既定取舍、简洁、尖锐。准备、刷新和固定范围见[使用指南](usage.md#重新改写对比文案)。

## 证据与导出

### 证据编号与原始坐标

模型从任务内追加式 evidenceBank 选择正整数 evidence_index；编号只能来自初始已展示材料或实际返回的工具内容。未知、越界和来源不符直接拒绝，不猜选证据。

程序展开完整 evidence_id、message_index 与 quote。文本/JSON 坐标包含输入 UUID、消息、路径与范围；图片须有真实查看记录。坐标可解析而非内容哈希；规范上下文 context_evidence 与直接行为 evidence 分开保存。

本方最终交付、数值 actual、指令和责任证据不能被 peer 代替。登记的同题 peer 原始事实可辅助核查，但对方最终回答不是独立事实依据。已接受 canonical 收据按原坐标恢复，不重新解释模型旧稿。

### 材料投影与来源目录

导航、调用概览、规范目录和引用目录只定位来源，不证明完整阅读、事实支持或实际交付。长最终正文沿 next_offset 读完，图片实际查看；未知来源不自动判伪造，检索未命中不证明不存在。

文本与 JSON 分页使用真实原文坐标；盲测和展示去重不改坐标。规范保留完整条件、例外及本方作用域，查询参数与元数据不当作工具返回。引用定位成功不等于支持整句，按真实协议与相邻来源核验。

规范目录的 `role=tool` 仅纳入已实际加载的技能：顶层 `view_skill` 调用和返回有明确关联号时精确配对，无关联号时只接受紧邻配对，并核对请求技能名与完整 `skill_content` 封套。普通工具事实、资产文件、失败或歧义返回、嵌套规划材料不因此获得规范权限；已确认属于独立规划链的加载同样排除。技能来源真实不代表其示例、目录或全部条款都是当前任务义务，仍保留条件、例外和候选作用域。

明确引用本方私规的发现不能关联共同要求，应选择本方专有要求或独立 `own_rule`，更换维度标签不改变作用域。Comparison 对已接受来源仍单独检查：引用与私规真实坐标有非空交集就不能借共同 USER 上下文扩大作用域，分页和短引文也不例外；共同授权仍要求完整原规范。独立完整的共同用户叶保持共同，旁边附加的私规不扩大或吞掉它。实际 `llm_turn` 输入中的 USER 块也可承载执行事实，只有已接受 Criteria 完整关联为本方私规时才机械加入私规排除；未映射的独有嵌套 USER 内容仍需语义核验，不能仅因不在共同原文中就判为私规。规则只使用来源身份与坐标，不按判词关键词分类。

读取、检索、表格和图片的参数、页长及重复读取反馈只维护在[工具说明](../packages/prompts/resources/tools/)；证据实现见 [Tools](../packages/tools/src/index.ts)、[Contracts](../packages/contracts/src/evidence.ts)。

### 正式导出与资源指标

正式对比按稳定模型 ID 保存 evaluations、assessments、ranking、源任务引用及 verdicts；三模型是三条独立行。both_good / both_bad 的 winner 为 null，待核不计平局。字段和位置见 [export Schema](../schemas/workflow/export.schema.json)、[运行产物](usage.md#运行产物)。

被评回答的耗时与 token 来自原始输入，缺失或冲突保持 null，不拿裁判用量或 trace 长度代替。比较仅用双方共有的有效指标；一方全部不劣且至少一项更少才派生资源优势，互胜或不可比时留空。模型只评重要性，程序呈现数值；token 不等于费用，单次耗时不代表长期性能。

资源统计与业务统计分开：胜负按对局，核心完成与标准一致性按回答去重，冲突及覆盖单列；完整指标见[质量分析](quality.md#矩阵区间与人工金标)。

### 数值与实体核验

numeric_references 只从可信标准提取，模型选 reference_index 并引用本方 actual 原文；程序绑定 expected、换算和算术 matches。exact 精确比较，rounded 按标准精度比较，未交付值用 null。matches 是算术观察，不强制决定 is_correct 或核心状态。

单位、对象、期间和舍入须按原文解释；只在明确唯一且同维时硬校验倍率。原始计算与展示值分开，不能二次舍入制造差异或反推缺失原值。实现见 [units.ts](../packages/agents/src/attribution/units.ts)。

[表格核验](../packages/agents/src/attribution/table-review.ts)只覆盖可解析的标准 Markdown 表及可比来源。unverified / conflict / ambiguous 是核查线索，不直接判错；只有 invalid_material 阻止正式比较。table_resolutions 须保留完整回答行与全部既有来源，不能裁去反证；语义是否支持仍由归因判断。

### 文案校验

结构、范围、证据和固定前缀可以机械校验；语气、事实忠实、责任与取舍须按[质量指南](quality.md)复核。测试不得用点评关键词或提示词原句冒充语义正确性。
