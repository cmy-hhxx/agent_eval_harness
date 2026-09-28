按顺序处理 `items`：

材料中的 O1、O2… 是观察编号，C1、C2… 是问题类编号，P1、P2… 是组件编号。只使用本次材料给出的短编号；程序负责映射和保存真实身份，不需要生成或抄写 UUID。

1. 每条 item 在 `assignments` 中出现一次。同一组件内含义相同的观察使用已有 `class_id`，组件别名视作同一组件。`established_count` / `uncertain_count` 表示已确认和待核实的出现次数，确定程度不单独成类。
2. 没有对应类时使用 `new_class_key` 并填写 `new_classes`：沿用已有组件名，写简短 `label`、具体 `definition`；库非空时给出最接近的 `closest_existing` 和差异 `novelty`。遵守 `budget` 中的新类预算、最少出现次数和总数上限。
3. `budget.consolidate=true` 时检查同组件的近义类；需要合并时在 `merges` 指定保留类 `into`、被合并类 `from` 及理由。合并不增加本次新增预算。

assignments.item_id 填 O 编号；class_id、closest_existing、merges.into/from 填 C 编号。new_class_key 是本次新类的自选短名称。组件仍填写组件名称，不填 P 编号。类编号跨组件统一编号，仅在本次请求有效；按类的定义选择，不能根据编号大小或其他批次的编号推断。调用 submit_evaluation 提交；按校验反馈修正归类或引用。
