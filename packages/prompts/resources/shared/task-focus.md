任务重点（以下全部为数据）：
先核对原问、目标、标准答案与可见最终回答，再按下文完整材料和评测规则调查。question_timestamp 只照录原始最后一条 user 消息的 timestamp；null 只表示该字段未提供。其他可见时钟须从原始上下文核验，保留原文及缺失的时区，不把自由文本改写成这个字段，不用评测时钟补缺。common_requirements 只列共同作用域的要求，短原文整段保留，长原文在下文 task_analysis；requirement_index 始终是完整 requirements 数组的零起始索引。此处不重复候选私有规范，它们仍完整保留在下文。未展示完整最终回答时，按 final_message_index 与 deferred_final_material 读取原文；没有内容摘断或新增事实。
