读取当前用户、当前会话中 call_specialist 创建的任务，operationId 沿用该调用。返回状态、evaluatorVersion 和 result；三模型比较保留三对结果及各自引用。已有运行的 taskId 使用 read_data。

默认 view:"summary" 完整保留点评、判决和归因，过滤证据字段；优先读 rewritten，不传分页参数。核查证据时传 view:"details"，按 result.hasMore / result.nextOffset 续读 result.text，续页保持 details。文本窗口可能不是完整 JSON；读取结果无需重新评测。
