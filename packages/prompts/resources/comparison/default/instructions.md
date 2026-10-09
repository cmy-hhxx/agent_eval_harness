1. 逐项比较。
- 使用共同 task_analysis 和双方已接受的 Attribution 结果，沿用已有 findings、归因及核心状态；必要时读取原文确认。只用已确认且影响原题交付的差异判优劣。
- 按 comparison_slots 的数量和顺序填写 `comparisons`，仅 optional=true 且无实质差异或无需展示时填 null。普通行双方 summary 围绕同一方面说明交付及影响；resource 行只填 importance 和 better_candidate，原始数值由程序呈现。
- scope=source_only 只写本方合规，better_candidate 省略或为 null；scope=pair 从 advantage_candidates 选择有事实支持的一方，无优势时省略或为 null。
- importance 衡量双方差异的实际影响，不沿用要求或共同优点的重要性：high 改变核心结果，medium 影响局部结果或实质修正成本，low 不改变结果或决策。

2. 核对依据。
- 对齐对象、时点、单位、口径与条件。核对隐藏标准由评审负责；只有原题要求核实给定说法时，才评价回答的核验与解释。标准中的补充统计、示例和中间值不自动成为必答或加分项；附加信息须改善用户所求才构成优势。
- 评审从来源中发现的事实，不写成回答已经作出的解释。已展示原文可直接核对，缺失部分用 read_trace 补读，图片用 view_image 查看；引用按本方协议判断。
- numeric_checks.matches 不代替正确性；结合原条件、correctness_reason 和原始计算核对单位、精度、容差和区间。双方结果已确认等价且满足原题时，更接近标准答案的写法、更多小数位或解释不构成实质优势；判优须指出实际改善的结果或使用成本。
- 已接受归因标记 standard_conflict=true 时，在相关点评与取舍中写“标准答案待复核：大概率是标准答案错了”，保留具体来源或计算依据；标准不符不能单独证明回答错误。各方事实分别核验，不将本方标记推写给对方，不自行改判或声称停止计分。

3. 比较资源并作出取舍。
- 资源槽由程序同时呈现完成耗时与总 token，缺失或异常按记录标明；不影响胜负也保留本行。
- 按 resource_metrics 和 comparable_metrics 比较。直接上报的总 token 与输入加输出可以对比；缓存缺失或字段名不同不构成口径冲突，缓存量不重复相加。总量异常依据 original_answer_usage.issues。耗时表示本次等待，token 表示记录用量，不直接代表费用或长期性能。
- 取舍按已有绝对值说明快慢与用量差异，不另算节省百分比；两项优势相反时分别说明。
- 核心可用者优先；双方核心不可用时判都差，仍可说明剩余用途和修正成本。双方核心可用时，根据共同适用方面已确认的中高重要性单方优势取舍；没有实质差距时 preference 省略或为 null。
- a_summary、b_summary 写各方实际结果、缺口及未核实范围。tradeoff 用一至两句说明决定性事实，保留落后方有意义的优势；单方未关联观察留在本方总评。

按 submit_evaluation 的 Schema 直接提交完整结果，按反馈修正。
