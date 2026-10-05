在 candidate 的消息中搜索 query 的逐字子串，返回匹配片段及 reference；不支持语义搜索或正则表达式。片段未覆盖完整条件时，用 read_trace 补读上下文，再判断是否支持结论。未命中只表示没有找到该字面词，不能证明相关事实不存在。
has_more=true 时，保持 candidate、query 不变，将 next_offset 原样作为下一次 offset。引用使用对应 reference。
