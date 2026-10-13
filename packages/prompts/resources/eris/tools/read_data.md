读取已有评测结果或原始消息。

- `{"reference":{"runId":"run","taskId":"task"}}` 默认 summary：comparisonScope 给出比较结论和问题维度，result 保留状态、标准答案、证据坐标或 rewritten 点评；不分页。
- `{"reference":{"runId":"run","taskId":"task"},"offset":0,"limit":8000}` 分页读取含证据的完整结果；传分页时自动使用 details，也可显式 view:"details"。显式 summary 不接受分页。
- `{"reference":{"runId":"run","inputId":"input"}}` 读取消息目录；在 reference 中加 messageIndex 读取节点正文（0起），不传 view。

run、task、input 用已返回的真实标识替换，taskId 与 inputId 二选一。offset / limit 在顶层；目录按条，正文按 UTF-16 字符计。有下一页时 nextRead 给出工具名和完整 args，直接调用即可保持原引用、模式和分页范围。
