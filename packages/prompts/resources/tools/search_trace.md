在当前任务可读取的消息中搜索逐字子串，返回配对的原文 quote 和 evidence_id；先核对原文是否支持判断，再逐字复制对应 evidence_id，不要自行拼接或改写。每页按工具输出预算返回完整的证据条目；has_more 为 true 时，保持 candidate、query 不变，将 next_offset 原样作为下一次的 offset。
