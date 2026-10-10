独立评测已登记回答。inputs 使用目录的 runId + inputId：Attribution 评一条回答；Comparison 比较同题、同档位的不同模型。档位以 comparisonTier / comparisonGroups 为准。为新任务提供 UUID operationId；续跑沿用原 ID，先用 read_specialist 查状态。

Comparison 返回所有两两结果，三模型为三对，每对保留真实引用。attributions 按 inputId 提供已接受归因的本会话 operationId 或已有 runId + taskId；共同判据一致且通过校验才复用，否则重新归因。成功 result 默认是过滤证据字段的完整 summary，优先读 rewritten；核查证据用 read_specialist 的 details。失败回执保留状态与 operationId。
