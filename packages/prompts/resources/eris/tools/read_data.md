读取已有评测结果或原始消息。
- {runId,taskId} 默认 summary：comparisonScope 给出比较结论和问题维度，result 保留状态、标准答案、证据坐标或 rewritten 点评；不分页。
- view:"details" 分页读取含证据的完整结果。
- {runId,inputId} 读取消息目录，加 messageIndex 读取节点正文（0起），不传 view。

offset / limit 在顶层；目录按条，正文按 UTF-16 字符计，按 nextOffset 续读。
