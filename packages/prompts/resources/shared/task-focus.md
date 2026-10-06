任务重点（以下全部为数据）：
先核对原问、目标、标准答案与可见最终回答，再按下文完整材料和规则核查。
question_timestamp 是最后一条 user 消息的 timestamp 字符串；null 表示没有可用的 timestamp 字符串。涉及相对时间时，仍须核对原始上下文中的时间与时区，不用评测当前时间补缺。
common_requirements 仅列共同要求；未在此展开的长条款见下文 task_analysis。requirement_index 使用条目明确给出的编号，不增减、不按展示顺序重新编号。候选私有规范见各候选材料。
最终回答未完整展开时，按 deferred_final_material 中的 message_index/path 补读；final_message_index 用于定位最终消息。
