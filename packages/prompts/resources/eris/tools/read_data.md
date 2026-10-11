读取单条材料或正式结果；案例先用 read_case，多个节点用 read_evidence。已返回的完整答案与判词无需重读。

- {runId,taskId}：默认 view:"summary" 返回点评、判决、归因与确定性，不含证据正文；优先读 rewritten，comparisonScope 给档位和胜负。summary 不分页。
- 同上加 view:"details"：分页读取含证据的完整结果。
- {runId,inputId}：消息目录，加 messageIndex 读正文，索引从0开始，不传 view。

引用原样使用，不混用 taskId 与 inputId。offset / limit 放顶层，目录按条、正文按 UTF-16 字符；按 hasMore / nextOffset 续读。本会话专业任务用 read_specialist。
