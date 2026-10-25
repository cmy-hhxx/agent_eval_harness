1. 按 comparison_slots 顺序比较。

每个 criterion 槽填写 importance、better_candidate 和 assessments。assessments 分 A/B，每格填写 status（met/partial/unmet/unknown/not_applicable）、evidence_status（已确认/待核实）、summary 和 finding_indices。finding_indices 选择本方既有 Problem 的零起始位置，不能新增或改写问题。完整阅读实际交付后，可以判断正常完成而不引用问题；已确认 partial/unmet 必须引用对应正式问题。没有问题记录的实质缺陷应请求 source_reviews，不把新问题直接用于胜负。原问与 acceptance_rule 只规定判断门槛，不代表回答已经满足。

仅本方适用的要求在另一方填写 not_applicable，不能支持横向优势。未知或不确定事实不能当作落后。对每项保留原句条件、期间、分母和影响范围；不能把可选说明变成必答内容，不能因未选另一个合理方案就判缺陷。importance 衡量实际差异：high 改变核心结果，medium 造成实质局部修正成本，low 不改变结果或决策。没有差异也保留共同必填槽，不重复登记优点。

resource 槽只填 importance，双方状态与方向由程序读取有效原始指标。资源默认 low；仅当显著影响实际等待或违反明确时间预算时提升重要性。不能从耗时差推测模型内部动作。

2. 独立判断核心完成。

顶层 assessments 分 A/B，填写 meets_core（true/false/null）、core_failure_refs、summary。它是 Comparison 本次判断，不从 attribution 抄状态。true 表示主要交付实际可用，不要求零缺陷；false 须有双方共同适用 requirements 的已确认 partial/unmet 比较格及正式 Problem，core_failure_refs 填这些要求的 ID；true/null 时 refs=[]。无法判断时保留 null 和具体原因，进入 needs_review。

has_standard_answer、is_correct、correct_reason 来自已接受归因。is_correct 只比较给定标准，既不证明没有其它缺陷，也不替代整体完成。计算和证据按问题内原有依据核对，单位、期间、容差、区间与原句限定必须一致。

3. 冲突与取舍。

决定性归因和实际原文冲突、遗漏正式问题、实际证据仍不足时，source_reviews 选择现有 slot_index/candidate，并说明实际主张、现有判断和冲突依据。共同对象、时段或完成门槛存在影响判决的未解决冲突时填写 scope_conflicts。此时 preference 和 relative_preference 为 null，程序保留空排名，不由 Comparison 修正归因。责任未知本身不要求复核已经确认的缺陷。

核心可用者排在不可用者之前；双方均不可用判都差。双方可用时，仅确证的中高重要性共同优势支持 preference；无实质差距时 preference=null。better_candidate 必须有同口径双方已确认判断。tradeoff 解释决定性差异、实际影响和反向事实，不按问题数量选边，不用泛泛“各有优劣”替代权衡。

relative_preference 在明确胜负时必须等于胜者；平局可以表达更倾向 A/B，但不改变都好/都差。仅实际交付和已确认事实等价且没有可区分差异时填 null，未核查不能冒充等价。

按 submit_evaluation Schema 提交完整结果，字段修复后重新核对全部业务结论。
