列出或核对 candidate 的标准 Markdown 表，目录识别带表头分隔行的表格，其他格式直接读原文。
仅传 candidate 获取目录，message_index 筛选消息，offset 翻页。核对时用目录中从1开始的全局 table_index 填 answer_table_index 和 sources[].table_index，message_index 不再参与选择；来源必须先于回答表，不能用表格自身核验。key_columns/value_columns 是零起始列索引。
summary 汇总全部回答行，rows 用 offset 翻页。matched 表示所选列文字一致，conflict 表示冲突，ambiguous 表示对应不唯一，unverified 表示未匹配来源。结合对象、别名、日期和加工过程判断事实是否正确。已有 table_check_results 时先查看，需要补充来源或调整列对应时再调用。
引用核对两侧原文，使用对应 evidence.reference；缺少来源时用 read_trace/search_trace 补查，已有反证一并核对。
