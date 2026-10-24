# 单题中的题目问题

判定原则见 [评判规则第6节](rubric.md)。题目问题与候选错误分别记录，当前Skill直接在本题JSON的findings中表达，不要求评分后再保存独立文件。

确认同一对象、时点和口径下的矛盾时，使用 `component: public_rule`、`attribution: established`，description以 `[题目问题-已确认]`开头，说明实际矛盾和受影响范围。仅有适用性或专业疑点时，归属记unknown或hypothesis，description以 `[题目问题-待核]`开头，写明待核问题。

问题记录仍使用固定的finding结构和共享evidence_ids。不能映射诊断时用 `primary_diagnostic_id: unmapped`、空diagnostic_ids，并给unmapped_reason。没有题目问题时不生成占位记录。

题目问题本身不证明候选错误；若候选对明确矛盾的处置另有可定位缺陷，另建候选问题记录并关联实际受影响项。明示的相容简化假设不构成题设矛盾。没有修复建议、改题方案或候选错误推断的附加字段。

执行器如需单独归档或展示题目问题，可以按component从本JSON提取；这一处理不属于当前裁判的后续任务。
