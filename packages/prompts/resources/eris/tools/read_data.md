读取目录返回的 reference：

- {runId,taskId}：正式结果。默认 view:"summary" 返回完整点评、判决、归因与证据确定性，过滤 evidence 等证据字段；优先读 rewritten 润色点评，comparisonScope 给模型、档位和对局结果。summary 不分页。
- {runId,taskId} 加 view:"details"：按需读取含证据的完整结果文本。
- {runId,inputId}：原始消息目录；再加 messageIndex 读取对应正文，索引从0开始。原始消息不传 view。

reference 保持原样，不混用 taskId 与 inputId。offset / limit 放顶层，仅用于 details 或原始消息；消息目录按条，正文按 UTF-16 字符。按 hasMore / nextOffset 续读，文本窗口可能不是完整 JSON。本会话独立任务用 read_specialist。
