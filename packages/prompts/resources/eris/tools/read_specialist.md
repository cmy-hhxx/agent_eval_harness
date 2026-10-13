读取当前用户、当前会话中 call_specialist 创建的任务，operationId 沿用该调用。返回状态、evaluatorVersion 和 result；三模型比较保留三对结果及各自引用。已有运行的 taskId 使用 read_data。

不分页时默认 summary，完整保留点评、判决和归因，过滤证据字段；优先读 rewritten。传 offset 或 limit 时自动使用 details，也可显式 view:"details"；显式 summary 不接受分页。完整调用示例：`{"operationId":"6a1b4a17-1039-4ead-ac32-9a37b0bf4ada","offset":0,"limit":8000}`，operationId 用真实任务标识替换。result.nextRead 给出工具名和完整 args，直接续读即可。文本窗口可能不是完整 JSON；读取结果无需重新评测。
