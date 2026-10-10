在指定原始输入中搜索文本。reference 使用 runId + inputId；返回匹配片段及可直接交给 read_data 的 messageIndex 引用。

offset / limit 放顶层，按匹配消息条数计；用 hasMore / nextOffset 续页。
