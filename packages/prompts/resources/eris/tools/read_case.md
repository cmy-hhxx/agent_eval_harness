一次读取用户原问、各模型最终回答、轻量链路地图，以及正式点评、判决和归因（不含证据正文）。

reference：{runId,taskId} 读取已裁决比较，{runId,inputId} 读取单条回答。先看原问与答案，再解释判词。

answers[].trace 提供步骤、工具名、短预览和节点引用；只有 callMessageIndex 确认调用关联，顺序不代表因果，预览不能代替完整证据。formal 的 evidence_references（或 *_evidence_references）是直接 reference，不含引文。

有缺口时，同一回答的必要节点合成 read_evidence，跨回答同轮并行，图像用 view_image。完整答案与判词不用重读。answer.complete=false 时按 answer.reference 补读；空回答保持为空。
