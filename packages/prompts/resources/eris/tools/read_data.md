补读单条材料或原评测。案例用 read_case，批量用 read_evidence；事实复核不回读旧评语，作图自动取得原判定。

- {runId,taskId} 默认 summary：comparisonScope 给结论和问题维度，result 补状态、标准答案、证据坐标；其他任务保留 rewritten 点评。summary 不分页。
- 加 view:"details"：分页读取含证据的完整结果。
- {runId,inputId} 读消息目录，加 messageIndex 读正文（0起），不传 view。

offset / limit 在顶层，目录按条、正文按UTF-16字符；nextOffset 续读。
