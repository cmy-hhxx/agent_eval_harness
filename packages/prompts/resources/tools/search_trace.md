在 candidate 的消息中搜索 query 的逐字子串，返回匹配片段及 reference；不支持语义搜索或正则表达式。scope 默认 all，按消息顺序搜索全部材料；tool_returns 只搜索原始工具返回，从新到旧排列，避开调用参数和模型历史中的重复文本。
核查数据依据时用 tool_returns 搜指标、对象或时间字段；回答中的舍入值、单位换算值可能不在原文，换用字段词定位。按命中的 read_request 调用 read_trace 读取完整字段及上下文，核对对象、时点、单位和原值。需查指令、请求或模型实际输入时用 all。未命中只表示所选范围没有该字面词，不能证明相关事实不存在。
has_more=true 时，保持 candidate、query、scope 不变，将 next_offset 原样作为下一次 offset；切换范围或查询词从 offset=0 开始。引用使用对应 reference。
