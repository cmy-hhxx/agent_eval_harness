读取 candidate 的 message_index 消息。已知字段时传 JSON 路径 path，例如 /content/0/text 或 /output/datas/0；字符串返回原始文本，其他类型返回原消息 JSON 中的对应片段。未知路径时省略 path，查看消息及 text_sources 目录；对象消息显式 path="" 读取根 JSON，不附路径目录。evidence 中的原文与 reference 配对，核对后选择对应 reference。
按待核疑点选择读取范围：优先用 search_trace 或代码定位原词与字段，再用 path、offset、max_chars 读取相关片段及必要上下文；无需例行读完整个工具返回。片段截断了对象、单位、条件、表格行或异常说明时继续补读；遗漏判断要覆盖对应完整范围。已读且足够的原文可直接引用，不为缩短引文重复读取，也不为省字符丢掉必要条件。
already_read=true 表示请求范围此前已完整展示，包括完整 JSON 字段所包含的原文本；局部 JSON 或其他位置的同文不算已读。显式指定 path 和 max_chars≤1800 的上下文核对返回完整片段，即使已读或部分重叠，也不拆散其中的条件和例外。重复请求仍消耗原探索额度。
更大范围的重复读取只返回 quote_preview 和证据编号；部分重叠时 evidence 返回新增原文，reused_evidence 提供已读区间的编号和 offset/end_offset。next_offset 指向请求实际处理的末端，不是新增文字长度。已有材料足够就直接复用，需要连贯上下文时定向读取相关短片段。
同一对象缺少多个邻接字段时，选它们的共同父路径并限制 max_chars，一次补齐必要上下文；搜索的 context 和概览中已有完整字段时直接引用，不再逐字段读取确认。
正文分页：has_more=true 时保持 candidate、message_index、path 不变，将 next_offset 原样作为下一次 offset；切换 path 后从 offset=0 开始。
路径目录分页：整条消息的 text_sources_has_more=true 时，将 text_sources_next_offset 原样作为下一次 source_offset。source_offset=0 是默认值；读取具体 path 时不用非零目录偏移，正文分页用 offset。
deferred_final_material 是正文之外的必读目录，列出的片段尚未展示在 final_answer 中。直接将条目的 read_request 作为调用参数，随后沿 next_offset 读完；修稿反馈的 expected.read_request 从首个未读位置开始。其他目录的 read_request 是按疑点补读的入口，不要求例行读完；只补齐判断所需条件、例外和上下文，不重复读取已有充分证据。工具反馈的 budget.required_reads 与 budget.exploration 分别列出必读和探索剩余额度。
提交返回 material_pending=true 时，本次只补给了一页尚未展示的原始材料，尚未评审草稿，也未消耗内容修正次数。先阅读附带的材料并核对原判断，必要时修稿；继续补读或重新提交，所有必读内容展示完整后才进入判词校验。
