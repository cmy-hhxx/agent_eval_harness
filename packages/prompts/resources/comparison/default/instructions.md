先使用 task_analysis、双方已接受的 attributions 和实际最终回答完成比较。已确认 Problem 是本次对比的既有事实，不逐条重新做归因，不遍历整段工具轨迹或重新执行全部计算。仅当决定性问题与最终回答冲突、某项共同要求无法判断，或存在必须查看的图片/延迟正文时，定向读取对应材料；冲突仍按 source_reviews 处理。

每格 summary 和顶层 summary 各用一句话说明满足情况及决定性依据；tradeoff 用一至三句话说明关键取舍。不复述整段答案、完整归因过程或所有已填写格子。所有必填槽和业务判断仍须完整提交。

1. 按 comparison_slots 的 slot_index 比较。每个提交行必须带同一个 slot_index 和 kind，同一槽只提交一次；候选专有槽无需评审时可省略该行，不能提交 null。

每个 criterion 槽填写 importance、better_candidate 和 assessments。assessments 是恰好包含 A/B 的数组，每项用 candidate 标明本方，并填写 status（met/partial/unmet/unknown/not_applicable）、evidence_status（已确认/待核实）、summary 和 finding_indices。finding_indices 选择本方既有 Problem 的零起始位置，不能新增或改写问题。完整阅读实际交付后，可以判断正常完成而不引用问题；已确认 partial/unmet 必须引用对应正式问题。没有问题记录的实质缺陷应请求 source_reviews，不把新问题直接用于胜负。原问与 acceptance_rule 只规定判断门槛，不代表回答已经满足。

每格 summary 只评价本格候选，主体必须是该候选本人；把双方比较留给 tradeoff，不在单格用“对方没有”或另一候选作为结论主语。better_candidate 只在实际给出更优判断的槽填写，理由必须落在本槽的同一验收事实内，且不能选择 status 更差的一方。双方 status 相同时，只有可核实程度确有差异才填 better_candidate；若本格事实已经表明一方没有完成该 requirement，应下调其 status 并按既有 Problem 或 source_reviews 处理，不能用 better_candidate 代替缺陷登记。

仅本方适用的要求在另一方填写 not_applicable，不能支持横向优势。未知或不确定事实不能当作落后。对每项保留原句条件、期间、分母和影响范围；不能把可选说明变成必答内容，不能因未选另一个合理方案就判缺陷。importance 衡量实际差异：high 改变核心结果，medium 造成实质局部修正成本，low 不改变结果或决策。没有差异也保留共同必填槽，不重复登记优点。

resource 槽只填 importance，双方状态与方向由程序读取有效原始指标。资源默认 low；仅当显著影响实际等待或违反明确时间预算时提升重要性。不能从耗时差推测模型内部动作。

2. 独立判断核心完成。

顶层 assessments 是恰好包含 A/B 的数组，每项用 candidate 标明本方，并填写 meets_core（true/false/null）、core_failure_refs、summary。它是 Comparison 本次判断，不从 attribution 抄状态。true 表示主要交付实际可用，不要求零缺陷；false 须有双方共同适用、高重要性 requirements 的已确认 partial/unmet 比较格及正式 Problem，core_failure_refs 填这些要求的 ID；true/null 时 refs=[]。无法判断时保留 null 和具体原因，进入 needs_review。

has_standard_answer、is_correct、correct_reason 来自已接受归因。is_correct 只比较给定标准，既不证明没有其它缺陷，也不替代整体完成。计算和证据按问题内原有依据核对，单位、期间、容差、区间与原句限定必须一致。

3. 冲突与取舍。

决定性归因和实际原文冲突、遗漏正式问题、实际证据仍不足时，source_reviews 选择现有 slot_index/candidate，并说明实际主张、现有判断和冲突依据。共同对象、时段或完成门槛存在影响判决的未解决冲突时填写 scope_conflicts。此时 quality_winner 和 relative_preference 为 null，程序保留空排名，不由 Comparison 修正归因。责任未知本身不要求复核已经确认的缺陷。

核心可用者排在不可用者之前；双方均不可用判都差。双方可用时，仅确证的中高重要性共同优势支持 quality_winner；无实质差距时 quality_winner=null。better_candidate 必须有同口径双方已确认判断。tradeoff 解释决定性差异、实际影响和反向事实，不按问题数量选边，不用泛泛“各有优劣”替代权衡。

relative_preference 在明确胜负时必须等于胜者；平局可以表达更倾向 A/B，但不改变都好/都差。都好或都差时，相对倾向只通过 relative_preference 表达，tradeoff 不再另写“更倾向/略偏 A/B”，避免程序前缀与正文方向相反。仅实际交付和已确认事实等价且没有可区分差异时填 null，未核查不能冒充等价。

按 submit_evaluation Schema 提交完整结果，字段修复后重新核对全部业务结论。
