按顺序处理 `items`：

1. 每条 item 在 `assignments` 中出现一次。同一组件内含义相同的观察使用已有 `class_id`，组件别名视作同一组件。`established_count` / `uncertain_count` 表示已确认和待核实的出现次数，确定程度不单独成类。
2. 没有对应类时使用 `new_class_key` 并填写 `new_classes`：沿用已有组件名，写简短 `label`、具体 `definition`；库非空时给出最接近的 `closest_existing` 和差异 `novelty`。遵守 `budget` 中的新类预算、最少出现次数和总数上限。
3. `budget.consolidate=true` 时检查同组件的近义类；需要合并时在 `merges` 指定保留类 `into`、被合并类 `from` 及理由。合并不增加本次新增预算。

调用 submit_evaluation 提交；按校验反馈修正归类或引用。
