逐条修正 errors 指向的字段，并检查相关引用和结论。提供 draft 时从该草稿修改；没有 draft 时根据本次材料重新评测。额度以本次预算为准。

expected.target 用完整 path 定位字段。错误路径中的数组位置从0开始，目录编号沿用材料给出的值。
若错误仅为 schema_additionalProperties 且 path=/candidate，只删除草稿顶层 /candidate，保留其他判断和证据编号，重新提交；这项字段修复不要求重新调查或改写全部归因。仍须遵守其他已列出的真实错误，不能静默忽略。
expected.submission_shape 用 type、required 和 properties 描述所需结构，按该结构填写经原文核对的内容。反馈含 slot_count/slot_order 时，先恢复槽位数量与顺序，再逐槽填写。

上次未接受草稿与错误：
