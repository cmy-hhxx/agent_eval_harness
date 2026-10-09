读取 candidate 的 message_index 消息。已知字段时传 JSON 路径 path，例如 /content/0/text 或 /output/datas/0；字符串返回原始文本，其他类型返回原消息 JSON 中的对应片段。未知路径时省略 path 或填空字符串，查看消息及 text_sources 目录。evidence 中的原文与 reference 配对，核对后选择对应 reference。
正文分页：has_more=true 时保持 candidate、message_index、path 不变，将 next_offset 原样作为下一次 offset；切换 path 后从 offset=0 开始。
路径目录分页：整条消息的 text_sources_has_more=true 时，将 text_sources_next_offset 原样作为下一次 source_offset。source_offset=0 是默认值；读取具体 path 时不用非零目录偏移，正文分页用 offset。
deferred_final_material 是正文之外的必读目录，列出的片段尚未展示在 final_answer 中。直接将条目的 read_request 作为调用参数，随后沿 next_offset 读完；修稿反馈的 expected.read_request 从首个未读位置开始。来源目录给出 read_request 时沿用其参数，读到 end_offset。工具反馈的 budget.required_reads 与 budget.exploration 分别列出必读和探索剩余额度。
提交返回 material_pending=true 时，本次只补给了一页尚未展示的原始材料，尚未评审草稿，也未消耗内容修正次数。先阅读附带的材料并核对原判断，必要时修稿；继续补读或重新提交，所有必读内容展示完整后才进入判词校验。
