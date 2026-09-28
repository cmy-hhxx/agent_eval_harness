按引用读取材料，三种调用互斥：
- 正式结果：reference 只传 runId + taskId；读取已接受结果及 evaluatorVersion，整条返回，不传 offset / limit。
- 原始消息目录：reference 传 runId + inputId；返回各条消息的角色、预览、长度和可直接使用的 reference。offset / limit 单位为消息条数，默认 30 条。
- 原始消息正文：reference 传 runId + inputId + messageIndex（从 0 开始）；offset / limit 单位为字符，默认 8000、最多 16000。通常省略 limit；需要续页时直接使用 nextOffset，hasMore=false 时已读完。

读取原始问题或回答时不要带 taskId。正式结果不存在时仍可按 inputId 读取原始材料。已有引用直接读，不重复查询目录。本会话独立专业任务的结果使用 read_specialist(operationId)。
