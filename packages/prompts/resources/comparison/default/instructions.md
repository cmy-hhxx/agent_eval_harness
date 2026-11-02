阅读 task_analysis、attributions、review_coverage 和 comparison_slots 后直接提交比较。已有归因结论是唯一内容判断来源，不要求重新证明其事实。complete=false 时，问题清单不代表完整核查；只在覆盖缺口影响当前核心判断时保留未知。归因总结已明确正常交付即可使用，不因缺少逐项 Problem 再次要求证明。

1. 按 slot_index 填写共同必填槽，每项仅一行；无须评审的专有槽可省略。criterion 行填写 importance、better_candidate、a_status/a_summary/a_findings、b_status/b_summary/b_findings。status 为 met/partial/unmet/unknown/not_applicable。findings 引用本方 Problem 的零起始位置，不新增、改写或重复调查问题。
2. 结合归因 summary、问题影响及 correct_reason 判断满足情况，不按问题数量选边。归因已说明正常交付时可判 met 且 findings=[]；partial/unmet 必须有对应正式 Problem。仅仅没有问题记录不足以证明未被归因覆盖的交付。未知格不能支持优势；同状态只有归因结论确认实质差异时才填 better_candidate，且不能选状态更差者。
3. 私有要求在另一方填 not_applicable，不能支持横向优势。保留原有条件、范围及例外，不增加交付义务。importance：high 改变核心结果，medium 造成实质局部修正成本，low 不改变结果或决策。resource 槽只根据给定原始指标填 importance，默认 low；明确影响实际等待或违反时间预算才提升，不能推测内部动作。
4. a_core/b_core 独立判断主要交付是否可用，不照抄 is_correct。true 允许局部缺陷；false 必须有共同、高重要性 requirement 的已确认 partial/unmet 格及正式 Problem，a_core_refs/b_core_refs 填对应 requirement ID；true/null 时 refs=[]。无法判断填 null，说明缺少的归因结论。
5. source_reviews、scope_conflicts 默认空数组。没有同名 Problem、两方问题数量不同、非决定性未知或责任归属未知，都不构成无法判定理由。只有总结与问题仍不能确定核心可用性，或直接冲突使所有充分胜因失效时，才用 source_reviews / scope_conflicts 记录具体限制，quality_winner、relative_preference 为 null。该结果直接交付，不启动复核、不自行取证。
6. 核心可用者优先于不可用者；双方均不可用判都差。双方可用时，仅已确认的中高重要性共同优势支持 quality_winner，否则为 null。relative_preference 在明确胜负时等于胜者；平局仅在已有事实支持有意义的偏好时表达相对倾向，否则填 null；局部未知和微小用量差异不强迫选边。tradeoff 必须写出具体交付事实、双方差异及为何影响取舍；不能只写“完成核心要求”“实际可用性更优”等结论性套话，也不重复整份归因。

每格 summary、顶层 a_summary/b_summary 各用一句短话，只评价本方；通常20–40字。tradeoff 用一至三句话交代取舍，不复述所有格子，平局不另写“更倾向 A/B”。完成后直接调用 submit_evaluation 提交完整结构化对象，不另写正文或 JSON 字符串。
