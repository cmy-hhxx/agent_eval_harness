在指定原始输入中搜索文本，返回匹配消息索引和片段，支持分页。

reference 只传 runId + inputId，在整个输入内搜索。offset / limit 单位为匹配消息条数，默认 20、最多 100；匹配项附带可直接用于 read_data 的 messageIndex 引用。按 hasMore / nextOffset 续页。
