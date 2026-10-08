先读 `items`、`library` 和 `budget`。O1、O2… 是观察编号，C1、C2… 是问题类编号，P1、P2… 是组件编号；引用沿用材料中的编号，component 填组件名称。

1. 每条 item 在 assignments 中恰好出现一次。先对照同一组件下已有类的定义、边界与别名，含义相同就复用 class_id。组件别名视为同一组件。检查本次涉及的近义类；budget.consolidate=true 时检查整个同组件目录。
2. 没有合适类时考虑 new_classes。component 沿用观察所属组件，已有组件优先使用目录 label。label 简短，definition 写可复用的行为、触发范围和可见结果。有已有类时，closest_existing 选择最接近的 C 编号，novelty 说明实质差异；无已有类时省略或填 null，说明新现象边界。
3. 遵守 budget：新增类数 ≤ max_new_classes，合并后活跃类数加新增类数 ≤ max_classes；新增组件数 ≤ max_new_components，组件总数 ≤ max_components。每个新类至少覆盖一条观察，所覆盖观察的 count 之和 ≥ min_support。无合适类且预算阻止新建时，deferred_reason 写明具体限制。
4. 同组件近义类用 merges 合并，into 为保留类，from 为被合并类，写明理由。每个 from 只出现一次，与所有 into 分离；观察归入保留类。合并后仍遵守 max_new_classes。用 class_updates 修改保留类的名称、定义或主题，每类一次并说明 reason。
5. category_paths 按现象组织，每类最多三条路径，每条最多三级，例如 `[["工具使用","工具输出误解"],["数值可靠性"]]`。每级为简短单行纯文本，禁用 `< > [ ] { }` 和控制字符，路径及路径内层级各自去重。沿用已有主题措辞；合并后超出三条时，在保留类的 class_updates.category_paths 中选择保留路径。

本批归类依据 items 描述与示例，目录整理依据 library 定义、边界和别名。established_count 是已确认次数，uncertain_count 是待核次数。label、definition 和主题用完整名称说明问题；业务型号和错误码按原文保留。

assignments.item_id 填 O 编号；每条在 class_id、new_class_index、deferred_reason 中只填一个。new_class_index 是本次 new_classes 的零起始位置，多个观察可归入同一位置。class_id、closest_existing、merges.into/from、class_updates.class_id 填 C 编号。

通过 submit_evaluation 提交完整结果，按反馈修正后重新提交。
