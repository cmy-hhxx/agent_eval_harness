列出或核对 candidate 的标准 Markdown 表；目录只识别带表头分隔行的 Markdown，未收录的其他格式仍须按原文核查。
仅传 candidate 可获取表格目录；message_index 可筛选消息，offset 可翻页。核对时选择目录条目的 table_index（从 1 开始），分别填入 answer_table_index 与 sources[].table_index；key_columns/value_columns 使用零起始列索引。使用条目显示的编号，不按筛选后的位置重新编号。
核对结果覆盖回答表全部行，summary 汇总全部状态，rows 用 offset 翻页。matched 表示所选列字面对照一致；conflict 表示冲突；ambiguous 表示对应不唯一；unverified 表示未匹配来源。它们不直接证明事实正确、错误或工具责任，须核对对象、别名、日期、来源截断和加工过程。已有 table_check_results 时先查看；需要补充来源或调整列对应时再调用本工具。
引用时核对两侧原文并使用对应 evidence.reference。无匹配来源时用 read_trace/search_trace 继续核查，不将未知判为正确或错误，不用后来的加工表覆盖早期反证。
