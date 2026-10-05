按引用读取材料，三种调用互斥：
- 正式结果：reference 只传 runId + taskId；读取已接受结果及 evaluatorVersion，整条返回，不传 offset / limit。已裁决比较另给 comparisonScope：comparisonTier 来自保存配置，模型展示名与每对正式结果来自该行 verdicts，不从长正文猜。双方均好/均差保留类别，tradeoff 相对评价不改判决。草稿、待复核及非比较收据仍可读，但不提供正式战绩 scope。
- 原始消息目录：reference 传 runId + inputId；返回各条消息的角色、预览、长度和可直接使用的 reference。offset / limit 单位为消息条数，默认 30 条。
- 原始消息正文：reference 传 runId + inputId + messageIndex（从 0 开始）；offset / limit 单位为字符，默认 8000、最多 16000。通常省略 limit；需要续页时直接使用 nextOffset，hasMore=false 时已读完。

优先原样使用目录返回的 reference：输入项的 reference 读取原始材料，tasks 内的 reference 读取正式结果。保留字段名，不把 taskId 换成 inputId，也不按 ID 外形猜类型。定位某份正式结果对应的问句/回答时，回到该运行输入目录，找出包含此任务引用的输入项，再用输入项的 reference 读取。

正式结果不存在时仍可按 inputId 读取原始材料。完整战绩与短正式依据已在 list_data 的 summary.formalComparisonStats，无需为效果概述逐份重读完整判词。已有材料和正确引用直接复用，只补当前问题缺少的原文。本会话独立专业任务的结果使用 read_specialist(operationId)。

案例点评先读完整原始问句，再读各模型决定判断的回答片段及其必要上下文，核对时间、口径、限制与交付要求。正式结果用于确认既有判决及证据，不能代替原始问句和回答，不能把判词写成被评模型的推理。
