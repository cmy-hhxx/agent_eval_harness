只查询当前用户、当前会话内由 call_specialist 创建的 operationId，返回任务状态、evaluatorVersion 和 result 文本页；3模型 Comparison 包含全部3对结果，每对附真实 runId/taskId 引用。operationId 必须来自那次调用，不是 list_data 返回的 taskId。已有评测运行的结果使用 read_data({reference:{runId,taskId}})。找不到 operationId 表示当前会话没有该独立任务，不能据此断言已有运行没有正式结果。

call_specialist 先返回结果首页；需要后续细节时调用 read_specialist({operationId,offset:result.nextOffset})。offset / limit 在工具顶层，limit 默认8000、最多16000字符。result.text 是 JSON 文本窗口；result.hasMore 为 true 时不是全文，不直接把片段作为完整 JSON 解析。不重新调用专业评测只为续页。
