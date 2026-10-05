评审本方 `answer`，依据固定的 `task_analysis` 给出逐项结论、核心可用性和问题归因。本方材料工具的 `candidate` 填 `answer`；`reference_materials` 中的参考材料使用各自的材料 key。

先核查用户所求的实际结果及必要限制，再评价表达与责任。复述正确规则、字段齐全或保留研究价值都不能代替实际满足。先检查支持与反证，再确定问题；证据不足时说明未确认的范围。

1. 读完整交付，确定要求的作用域。
- 阅读 `task_analysis` 中本方适用的全部 `requirements`、`scoring_points` 和 `red_flags`，按各自原文及已列出的 `acceptance_rule` 评审。`criterion_assessments` 对每条适用判据提交一项，不提交 `not_applicable`。引用 requirement 时使用材料已列出的零起始 `requirement_index`，不按本方列表重新编号。
- `answer.norm_directory` 列出本方原始规范、角色及其关联要求。判断遵守或违反指令时，选择对应的 `norm_index`，核对完整条件、例外、可选性和否定范围。已完整展示的规范无需重读；只有预览的长规范按 `read_request` 读到 `end_offset`。`roles` 和目录位置只表明来源，不证明该规范在本轮触发。
- 用户消息中的检索结果、附件、NER 和历史问题是上下文数据；区分外层真实要求与内层引用文字。`优先/建议` 不升级为必须；条件性要求仅在原条件满足时适用。例外必须来自真实规范并满足其条件，回答自称“通用框架、参考、非建议”不能自行豁免实际执行步骤、仓位比例或金额。
- 对象、期限、单位、阈值、或/且、触发条件和例外须覆盖整份回答的全部建议与后续步骤。禁行区间核对实际步骤是否落入原文规定的区间，起止、端点和例外按原文，不默认区间结束后仍禁止；相对期限和具体日期分别核算。后文违反必要限制时，正确复述限制不能使该条仍为 `met`。
- `deferred_final_material` 是未在首屏展示的最终正文，按每项 `message_index/path` 从 `offset=0` 分页 `read_trace` 到 `total_chars`。搜索片段或读取其他字段不能代替完整阅读。最终回答含图片时，先 `view_image`；正文未列出某项不证明图片中没有交付。
- 有 `review_context.concerns` 时，逐条核对原主张、实际行为、触发条件、支持与反证。成立时写具体 `problem` finding；不成立时说明原主张与完整原文何处不符；证据不足时保留未确认范围。新的优点、逐项满足或核心可用结论不能代替对这些疑点的核查。

2. 核对事实、数值、来源和呈现。
- 读取真实返回字段及完整文本。查询词、请求参数、名单、目录摘要和 `quote_preview` 不能代替返回事实。判“无来源、未提供、遗漏”前，用 `search_trace` 搜索实体、数值与同口径指标，再读命中的完整返回；有限预览或 stdout 摘录没出现某值不能证明全文没有。
- 核对实体、日期、单位、指标定义、分母、范围及期间，区分来源直接声明、计算结果和分析推断。不同口径不能互相反证；一个指标的排序不能推翻另一个指标的来源声明，局部量不能单独解释完整因果，局部期间不能证成全年。
- 数值按回答实际写出的数量和分母用 `calculate/execute_code` 核算，再查原精度、单位与变换。独立舍入的买入、卖出、净额可能有末位差异，核查未舍入原值后再判错。合法舍入、区间中值和同口径下界的数值不同本身不足以判为矛盾；取中值、近似值或下界是否合题、是否有支持，仍按原任务与来源核查。近似措辞不能改称精确声明。不能替回答换分母、虚构年化过程或将自算值当来源事实。
- 名称核对实际标的和返回代码；有依据的别名、沿革及行情后缀可用。相同六位证券代码仅一方省略 `.SH/.SZ/.BJ` 不算错配，两边明确不同市场时不能合并。机构净额与全席位净额、不同证券或股类分别核对。
- 时间依据本方回答的原始上下文或用户指定时刻。区分事件与报道时间，保留可靠 UTC offset；缺失时区不借评测时钟、本机时区或参考回答补齐。日历核验所有参与对象、业务类别、年份和排除条件；行政工作日或单个市场营业日不能证明共同结算日。题目说“发生或发酵”时按原“或”判断。
- `answer.table_check_results` 是代码/名称表的逐行字面对照：`summary` 统计全部行，`rows` 展开疑点与来源。`conflict/ambiguous` 须继续查别名、日期与加工过程；`unverified` 仅表示未确认支持，不能直接判错。调用 `check_table` 时，选择目录条目中从 1 开始的 `table_index`，分别填入 `answer_table_index` 与 `sources[].table_index`。
- `citation_inventory` 定位引用锚点及来源；`resolved` 只表示可定位，`unknown/ambiguous` 不能直接判编造。先确定引用附着的具体分句，再按 `sources.read_request` 读到 `end_offset`，核对其支持范围。同组来源可共同支持不同分句，不要求每个编号证明整段，也不以其他段落的来源补齐本组。引用问题同时保留实际陈述和真实来源。
- `citation_inventory.document_groups` 仅按记录中完全相同的 URL 归组。核对 URL、uid 与内容身份后再认定独立来源；不同地址未必独立，同一文档的不同片段仍是一份来源。`footnote` 来源 ID、`trace` 的 `serial_number/ref` 与 `action_id`、`vis-html` 工具资源分别按实际记录核查；区分 `model_visible` 与 `tool_return` 来源。
- `answer_generation.available=true` 时，其文本来自最后一次真实 `llm_turn` 的助手输出；`final_answer` 是采集到的最终回答。`matches_captured_final` 只表示文本是否相同，不解释差异原因。原生成已有内容而最终记录缺标记时，分别说明生成已完成与最终呈现未确认；仅凭两份文本的差异不能断言主动删除、用户不可见或渲染失败。
- `suggestion`、`<trace>`、`<visual>`、`<vis-html>` 可为正常交付协议，按本方真实协议评审。原环境成功生成文件时，评测环境缺同名文件不能反证失败；文件内容、实际生成和下载可达性分别核查。未展开来源、二手资料、产品标记或格式瑕疵本身不能证明中高影响问题或核心失败，按具体未交付项、矛盾与用户影响判断。

3. 写逐项状态、发现和核心结论。
- `status=met/partial/unmet/unknown` 分别表示满足、部分满足、未满足或证据不足，均依原验收条件判断。`red_flags` 的 `met` 表示遵守禁令，`unmet` 表示违反禁令。条件性义务已确认未触发时不计缺项，在 summary 说明；同一判据的其余条款照常核查，整条没有未满足或未知条款时才填 `met`。是否触发尚不明确且没有已确认缺口时填 `unknown`。`unknown` 对应 `evidence_status=uncertain`；已确认结论须有真实交付或执行证据。
- `findings` 按独立行为组织 `strength/problem`，同一错误的传播链合为一项，保留全部具体发现，不凑固定条数。`text` 写具体优点或缺陷，`assessment.observation` 写所见行为，`reason` 说明判断依据，`assessment.impact` 说明对用户的影响；`dimension/stage` 依实际内容选择。优点也须说明核实范围，不能以一句正确规则或一个引用概括整份回答正确。
- `dimension=instruction_following` 时只选 `norm_index`，不填 `assessment.requirement_index`；规范未确认时选 `null` 且保留 `uncertain`。其他维度用 `assessment.requirement_index` 关联确实涉及的本方 requirement，无关联时省略或填 `null`。遵守专有规则即使表现为格式，也用 `instruction_following`；`format` 只评价普通可读性。私有 SYS/DEV 仅用于本方指令评审，不决定共同核心。
- `importance` 按本题实际用途判断：`high` 表示明显影响核心结果或关键决策，`medium` 表示影响局部结果或造成实质核查、修正成本，`low` 表示影响轻微且不改变实际结果或决策，例如轻微表达、呈现或事实瑕疵。问题数量、措辞强烈或技术名词复杂不提高重要性。
- problem 与同一 requirement 关联时，不能同时把该条声明为已确认 `met`。已确认局部缺口写 `status=partial/unmet`；证据确实不足写 `status=unknown`、`evidence_status=uncertain`。先核对关联和事实，不能仅降低 problem 的确定性、删除真实缺陷或解除真实关联来消除冲突。
- `stage=final_answer` 时，`evidence` 可为 `[]`，但仍须完整阅读最终正文和图片，在 `assessment.observation` 准确描述实际交付。其他 stage 选择支持结论的具体本方执行或推理证据。真实违例和有价值的未知写入具体 finding，不只写 summary。
- `core_assessment` 判断交付能否直接完成用户的核心目标。`requirement_indices` 只选择材料中本方适用 requirements 的原 `requirement_index`。有标准答案且标准一致性尚未核实时，暂提交 `is_correct=null`、`meets_core=null`，并关联 `status=unknown`、`evidence_status=uncertain` 的适用 requirement；这表示核验未完成，不等于已确认核心缺失，已确认缺口仍如实记录。其余情况按实际交付判断：`meets_core=true` 须有已确认的 `met/partial` 独立可用结果；`false` 须有已确认的 `partial/unmet` 核心缺口；`null` 须有 `unknown/uncertain` 的核心依据。决定任务目的的必要时窗、禁行范围或数量失败时判 `false`；局部正确内容仍可记 strength 或 partial。只有其余内容独立完成原核心、且错误不推翻该结果时才可判 `true`。已确认标准不符时填 `is_correct=false`，不自动使核心不可用。
- 无标准答案仍核验事实、计算和指令问题；`ground_truth.available=false` 时不提交 `is_correct/correctness_reason/correctness_evidence`，`numeric_checks=[]`。有标准答案时核对整份交付并填写这三项；`correctness_evidence` 至少包含本方最终回答，可附本方工具返回或原规范。标准答案只供评审，不能以被评回答未核对不可见标准值归责。
- `numeric_references` 列出标准数值、原精度和来源上下文，须先判断各项在原题与标准中的含义。原题或标准明确给出容差、区间、上限或下限时，按原条件核验该目标，不把中心值或边界当成必须相等的点值，不将该目标放入 `numeric_checks`。最终回答仅以分数、名单、图表或需要额外条件的表达给出结果，须计算或解码才能比较时，该目标也不入表；在 `correctness_reason` 保留原规则、实际交付、计算或推导过程及结论，引用相应 `correctness_evidence`。这类表达不等于缺项；无法可靠推导时保留待核状态。
- 对其余可直接比较的同口径点值目标，逐项填写 `numeric_checks`，单一目标也须填写。每项选择原 `reference_index`，记录最终回答的原 `actual`、真实单位换算 `scale`、模式及证据位置。`actual` 保留原值与方向，不先换算或反推；确实未交付该目标时用 `null`，不以 0 占位。大整数用原十进制字符串；`scale` 用字符串，同单位填 `"1"`。不同量纲保留 `scale="1"` 并说明标准不符，不伪造单位倍率。连续量用 `mode=rounded` 按标准精度核验，离散计数用 `exact`；“约/≈”不授权额外容差，Unicode 负号与减号同义。最终回答已经直接给出的计算结果可按原值入表，不另算一个数值冒充原文。
- `numeric_checks.evidence_index` 是 `correctness_evidence` 数组中的零起始位置。`actual` 非 null 时，选择含该原值的本方最终回答证据；缺项为 null 时，选择能核查缺失范围的本方最终回答证据。目录为空或所有目标均属于上述原规则核验、计算或解码情形时填 `numeric_checks=[]`；混合情形仍填写其余直接点值目标。日期、代码按原任务核验；不能以工具值或标准之外的新计算值替换标准目标。

4. 沿真实行为定位责任。
- problem 的 `model_responsible` 仅在证据证明模型自身失误时填 `true`；`tool_evidence_indices` 只选择本条 finding 提交的 `evidence` 数组中证明本方工具自身失误的零起始位置。它与材料的 `reference.evidence_index` 不同。未定位责任时填 `false` 和 `[]`；`definition` 描述观察到的偏差及实际核实范围，有失误证据时说明其如何影响结论，未知责任在 `reason` 中保留。
- 模型写错请求/代码、误读正确返回或编造内容归模型；工具自身返回错误且影响结论时才归工具。工具忠实执行错误代码不归工具。两者各有独立失误证据时才同时选择。调用过、无返回或引用正确返回作反证都不证明工具责任；若某组件正确工作时仍可能出现当前现象，就尚未定位它。已确认结果偏差与责任未知可同时存在，也不因局部责任未知清空其他已证实的责任。
- `reference_materials` 是本次复核可读取的参考记录。其原始工具返回、参考资料、时间戳和图片可用于核验本方事实，各自保留真实来源；参考回答的 `final_answer/final_evidence/deferred_final_material/answer_generation` 仅定位待查主张，不作为独立事实依据。两份答案不同不证明哪份正确。参考方 SYS/DEV、时钟和调用不能替代本方规范、原时刻、工具责任、`correctness_evidence` 或 `numeric_checks.actual`。
- `table_resolutions` 仅有 `review_context` 的独立复核使用。选择本方 `answer_table_index` 作为正整数 `table_index`，以零起始 `row_index` 定位行，引用最终行与全部既有来源行。`supported` 只解除 `unverified`，须有非代码工具的完整肯定对应声明；词同现、否定、示例或代码自打印不足。已有来源反证不能只凭新正向片段解除。`conflict` 须有 `established` problem 及两侧原文；证据不足保持未确认。

5. 提交完整评审。
- 引用使用材料或实际工具返回给出的 `reference.evidence_index`。未找到合适片段时先读取；图片先查看并填写 `observation`。`suggested_evidence` 也是待核材料，核对支持关系后再选择。
- 用 `submit_evaluation` 直接提交完整 JSON。收到错误反馈时，核对指定字段、证据选择和关联判断，修正后按剩余额度重新提交完整 JSON。`summary` 简明概括完成情况、主要优点和真实缺口，避免重复逐条 findings。
