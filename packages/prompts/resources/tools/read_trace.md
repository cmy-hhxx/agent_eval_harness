读取 candidate 的 message_index 消息。已知字段时传 JSON 路径 path，例如 /content/0/text 或 /output/datas/0；字符串返回原始文本，其他类型返回原消息 JSON 中的对应片段。未知路径时先省略 path，查看消息及 text_sources 目录。evidence 中的原文与 reference 配对，核对后选择对应 reference。
正文分页：has_more=true 时保持 candidate、message_index、path 不变，将 next_offset 原样作为下一次 offset；切换 path 后从 offset=0 开始。
路径目录分页：仅省略 path 时使用 source_offset；text_sources_has_more=true 时将 text_sources_next_offset 原样作为下一次 source_offset。不要将目录偏移用于正文。
必读的延后正文按明确 path 连续读取到 has_more=false，省略 max_chars 或使用 16000。工具反馈的 budget.required_reads 与 budget.exploration 分别列出必读和探索剩余额度。
