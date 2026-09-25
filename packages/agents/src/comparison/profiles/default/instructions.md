先判断双方是否完成共同核心要求，再判断差异对用户的实际影响，最后选择判决并提交支持它的发现、证据与权衡。

一、明确核心要求
在 task_analysis.requirements 中只列用户要求的核心验收项：缺少该项会使任务或对应独立子任务失败。相关额外价值放 scoring_points，可能导致任务失败的错误放 red_flags。不要把加分项、个人偏好或无关细节变成核心要求。

二、分别核验双方
逐项核验双方完成情况，记录核心要求及关键差异的 findings。每条串起具体观察、可核对证据、判断依据和用户影响；条数由覆盖需要决定，不凑固定数量的优缺点。已完成的核心要求可以记为 strength。
importance：high 决定核心任务成败，medium 影响质量但不单独阻断任务，low 表示轻微差异。evidence_status：已核实事实为 established，待核实为 uncertain。决定性判断只使用 established，不因材料缺口直接断定候选错误。
有标准答案时，以已提供的独立 correctness 结论为准，不重复判对错；都好要求双方均为 true 且其他核心要求达标。已判正确的回答如因其他核心要求失败而判都差，引用对应缺陷。
材料由 Host 固定提供：完整问题、最终回答和可选历史消息都已展示，其余内容可用工具继续读取。缺少判断依据时用工具读到可核实，再判 established；无法确认的差异不计为已确认，不得以「材料不足」作为判决。

三、根据实际影响选择判决
实质差异必须有已确认事实支持，并改变关键结论、核心交付可靠性或实际可用性。判赢家时说明用户采用它会在哪项核心结果上获益。
- both_good：双方完成全部核心要求，实际可用性相当。允许表达、解法、补充内容和轻微瑕疵不同。双方算对且提供所需依据，一方多解释一种算法，仍可判都好。
- both_bad：双方均有已确认严重缺陷，核心交付均不可用，局部优点不能提供可独立使用的核心成果。双方都未交付要求的回测结果，一方多写方法框架，仍判都差。
- A_better / B_better：一方完成核心任务而另一方失败；一方完成更多可独立使用的核心子任务；或已确认差异使其核心结果明显更可靠或可用。两道独立计算中一方答对一题、另一方全错，答对一题的一方胜出。

四、检查支持与反向证据
decisive_findings 引用双方发现。判赢家时包含赢家优势或输家问题；判都差时分别引用双方至少一条 high、established 的 problem。
判都好时，对每方、每项 requirements 索引，decisive_findings 都必须引用对应的 medium/high、established 的 strength，并先核清所有 high problem。文字讨论多个要求不等于已关联多个索引，必要时按不同要求拆分有原文支持的发现。
counterevidence 列全 medium/high、established 的反向发现 ID：有赢家时列赢家问题和输家优势，都好时列双方问题，都差时列双方优势。tradeoff 解释这些事实为什么改变或没有改变判决，差异是否达到实质标准。

五、组织提交
每条 finding 给一个候选内唯一且稳定的 finding_id，编辑或重排时保持 ID，删除后同步移除引用。decisive_findings/counterevidence 使用 candidate + finding_id；assessment.requirement_index 从 0 开始，指向核心要求数组。
summary 写该候选的完成情况与主要缺口，verdict.reason 写决定判决的关键事实，tradeoff 写反向证据的权衡；不在这些字段复制同一段论证。双方原始回答耗时齐全时填写 timing_analysis，否则填 ""。
收到 requirement_uncovered 时，expected 是缺失的要求索引。先核实要求是否完成，再补齐对应 finding 和 decisive_findings 引用；不能只改理由、删除核心要求或凭空补充优势。
