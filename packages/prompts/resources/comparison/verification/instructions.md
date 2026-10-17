第一步：独立核查原材料

按 `verification_check_slots` 原顺序填写 checks。每条要求分两槽：
- delivery：核查对象、结果、完整度和事实。
- constraints：将限制、禁行步骤、时窗、阈值、触发条件和例外应用到全部实际条目、建议与后续步骤。没有额外限制时填 not_applicable；整条要求未触发时两槽均填 not_applicable。

result 填 supported（全部适用要求已确认满足）、contradicted（已确认违反或矛盾）、unverified（必要事实待核）或 not_applicable。observation 写核查范围、具体结果和必要计算；source_evidence 选择原始支持或反证，原要求和标准已足够时可为空。checks 只填槽位的检查字段。

每个 contradicted 检查都在 concerns 记录本方同一要求的具体反证，其他发现也写入 concerns：
- candidate 选择本方，requirement_indices 使用目录的全局零起始编号。
- answer_evidence 选择本方最终回答或确证最后模型生成的 `reference.evidence_index`。内容违规定位原句；缺项引用应交付该项的完整范围。
- source_evidence 选择真实支持或反证。过程违规引用本方规范、违规调用或执行记录，answer_evidence 关联最终交付。原要求、标准和回答已足够时可为空。
- reason 写具体行为、适用规则和冲突。

同时核查材料中可见的本方适用 SYS/DEV 规则，长规范用 `read_trace` 读全。违规规则尚未列入 requirements 时，requirement_indices=[]，source_evidence 选择该规范及必要的过程事实。私有规则只核查所属候选。

完成 checks/concerns 后写入 JSON 文件，通过 inspect_material 提交 path，再阅读揭示材料。已有 material_inspection 时直接进入第二步。

第二步：对照归因与草稿

先核对已有 problem 的事实、等级与责任，再核对草稿采用的 strength、要求状态、核心状态和逐项取舍。

`inspection_context.verification_concerns` 是疑点目录，concern_index 使用该目录的零起始位置。concern_matches 只确认既有 established problem 已记录同一缺陷与责任；finding_indices 从 `inspection_context.eligible_match_choices` 对应的 eligible_findings.finding_index 选择。逐一对照实际行为、回答片段、完整规范与责任，准确对应才填写匹配。

首查疑点经补读原文确认不成立时，可用 concern_refutations 选择 concern_index，填写 source_evidence 和 reason，说明原先遗漏的上下文及反证；至少引用一条真实原材料。不能仅因归因或草稿作了不同判断就撤销疑点。一个疑点只能匹配、反驳或保留待核，不得重复选择；首查记录本身保持原样。

继续检查逐项状态和核心结论是否与原文一致。必要条件未满足时，检查回答还能否完成主要任务。首查为 unverified 时，查明归因中的结论依据哪份原文。归因已填 unknown 且未据此判错或判优劣时，无需复核。

source_reviews 只列需要更正的归因疑点。slot_index 用揭示后 comparison_slots 的零起始位置，candidate 选该槽的 reviewable_candidates，reason 写具体冲突、来源与责任依据。同格疑点合为一条，无需更正填 []；资源槽和纯排名取舍不提交来源复核。

按 Schema 提交 concern_matches、source_reviews。一次列全独立疑点；收到反馈后修正对应选择和说明。首查疑点目录为空时 concern_matches=[]。

两步共用的核查方法

- 先核对已展示原文，缺失部分用 `read_trace` 补读；图片用 `view_image` 查看。未完成核验的范围记为 unverified，不据此制造候选缺陷。
- 判定缺项或缺来源前，先核对可见材料目录；有可用记录时，用 search_trace 查实体、数值和同口径指标，再读取命中全文，并核查相关最终交付。引用核对其所附分句及同组来源的支持范围，按本方真实引用协议判断；同一文档的片段、译文和重复返回算一份来源。
- 数字先按完整语境区分目标、阈值、日期、代码和事件名，再对齐实体、单位、期间与指标定义。用 calculate/execute_code 按原始数量与分母核算，检查舍入和近似依据，避免二次舍入制造差异。显式容差、区间和上下限按原条件核验；揭示后的 numeric_checks.matches 只记录算术比较，正确性须核对 correctness_reason 的规则、原值、计算与证据，不能由一个布尔值代替。
- 时间取自本方原始上下文或用户目标时刻，按可靠 UTC offset 换算；区分发布与事件时间。时间区间按原文核对起止、端点和例外，相对期限与具体日期分别核算。日历检查全部对象、业务类别和年份。
- 分别核查可见的工具原始返回、模型实际输入、原生成和最终呈现。不能把原始返回当作模型已见内容；误读实际输入归模型，正确返回在输入中丢失或改变归上下文组装与传递，工具自身错误且影响答案才归工具。答案错误与责任定位分别核实；已有输出缺陷已确认而 component=[] 时，核对其事实，不仅因责任未定位请求复核。已核实错误来自标准时，记录具体冲突，不给正确回答或工具记责，也不要求候选解释隐藏标准的错误。
- ranking_tiers 同层表示并列。资源按 `resource_metrics` 与 `comparable_metrics` 核对完成耗时和总 token；直接上报总量与输入加输出可比较，缓存缺失或异常不影响有效总量。token 表示用量，原始耗时表示本次等待；复核请求须落到具体归因事实。

提交时，用 `execute_code` 将结果写成 JSON 文件，再调用对应工具：首查用 `inspect_material`，揭示后用 `submit_evaluation_file`。内容按各工具的 Schema 填写；失败时按反馈修正文件再提交。
