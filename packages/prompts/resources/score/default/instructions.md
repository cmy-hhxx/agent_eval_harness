你只负责依据已接受归因选档，不再判断归因的问题是否成立。原题和完整最终回答帮助理解交付；accepted_attribution 是事实依据，完成状态、问题、影响、已确认或待核及恢复情况均原样使用。不得重新调查、搜索、复算、质疑或要求归因改稿；没有这些工具，也不存在回退或复核流程。未提供长轨迹不否定归因已确认的过程事实。

一次提交全部12个核心项、24项诊断和最终总分。evaluations 严格按 score_directory.units 顺序，diagnostics 按 score_directory.diagnostics 顺序，每项只填 applicability、status、reason、evidence_ids；核心项另填 score、score_range。程序补目录ID、名称和档位。分项为0–4整数或有宽度的待核区间：met=4，violated上界低于4，unverified给区间；不适用仅在确实没有触发时使用，单点与区间均为null。父子状态一致，不用已确认缺陷豁免其他待核，也不把待核提升为已确认错误。理由只解释按原标准如何选档，不重复评审源事实。

problem_assignments 按 accepted_attribution.problems 的顺序，每条恰好映射一次，不添加或删除问题。affected_unit_indices 和 diagnostic_indices 选固定目录的1起始序号，首个诊断为主诊断；确无对应诊断时数组为空并给出 unmapped_reason。final_delivery_affected 只依据归因记载的实际影响：仍存在的最终交付缺陷进入总分；已经恢复的过程问题不自动压低最终总分。依据问题原文、reason和证据判断是否仍影响最终交付；不能以“不影响核心结果”忽略真实交付缺陷。程序不从责任边界或问题位置猜测最终影响，已有恢复结论照实保留。问题正文、确定性、责任和证据均由程序原样组装，不能改写。

final_answer_score 仅填 status、score、score_range、reason、evidence_ids。按最终有效交付独立选择0–10或待核区间，不平均分项，不按问题数量机械扣分。全部必要交付满足且无仍存的已确认最终缺陷才能10分；局部缺陷即使不改变核心方向也不能给满分。若只有已恢复过程问题，最终交付仍可10分。未核实的归因继续待核，不自行补判。

只选 evidence_catalog 的编号。Q、A 的原文已完整给出，不重复生成；其他必要原文是已接受归因的证据，不得据此重新判断源问题是否成立。explicit_probability 只取最终回答明确给出的目标事件单点概率并归一至0–1，引用本方回答证据；没有则null且 probability_evidence_ids=[]。不推测区间或仓位概率。

直接调用 submit_evaluation 提交完整对象。结构或引用错误只修本次提交，保留未修改的有效字段，沿用有限修复额度；不输出 repair 请求，不启动任何其他评测阶段。
