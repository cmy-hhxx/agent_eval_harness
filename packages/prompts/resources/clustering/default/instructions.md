先读 `items`、`library` 和 `budget`。O1、O2… 是观察编号，C1、C2… 是问题类编号，P1、P2… 是组件编号，A1、A2… 是回答编号；只以 established_answer_ids 中的编号计算已确认支持。引用沿用材料中的编号，component 填组件名称。

1. 每条 item 在 assignments 中恰好出现一次。先对照同一组件下已有类的定义、适用边界、别名与 examples；示例包含不同回答、日期和确定程度，finding/reason 来自已接受原归因，原文引文与引用只帮助追溯。现象及适用边界相同才复用 class_id，不把不同偏差塞入“核验不足”“未遵循要求”等笼统类。组件别名视为同一组件。检查本次涉及的近义类；budget.consolidate=true 时检查整个同组件目录，收紧过宽定义并合并仅措辞不同的类。
2. 没有合适类时考虑 new_classes。component 沿用观察所属组件，已有组件优先使用目录 label。label 用普通读者能懂的短句，直接说哪里出了什么问题；“事件回应”“回答质量”等主题或任务名不能充当问题类，须描述具体可观察的缺陷及对象，必要时说明后果，例如“遗漏事件时点，导致受益股判断错位”，示例不构成固定格式。definition 说明可复用的行为、触发范围、可见结果和不包括什么，不能把单题实体、日期、数值或未知成因写成新类别。有已有类时，closest_existing 选择最接近的 C 编号，novelty 说明实质差异；无已有类时省略或填 null，说明新现象边界。
3. 遵守 budget：新增类数 ≤ max_new_classes，合并后活跃类数加新增类数 ≤ max_classes；新增组件数 ≤ max_new_components，组件总数 ≤ max_components。每个新类至少覆盖一条观察；将这些观察的 established_answer_ids 去重，独立已确认回答数须 ≥ min_support。同一回答多个 finding 只计一次，uncertain 不计支持。低频或只有疑似样本且无适用现有类时，用 deferred_reason 说明待观察原因，不硬塞其他类别、不合并不同现象凑支持数。
4. 同组件近义类用 merges 合并，into 为保留类，from 为被合并类，写明理由。每个 from 只出现一次，与所有 into 分离；观察归入保留类。合并后仍遵守 max_new_classes。用 class_updates 修改保留类的名称、定义或主题，每类一次并说明 reason。
5. category_paths 按现象组织，每个新类填写一条主要路径，最多三级，例如 `[["工具使用","看错工具返回"]]`。每级用通俗的简短单行纯文本，禁用 `< > [ ] { }` 和控制字符，路径内层级去重。先复用已有主题措辞；没有实质分类价值时不细分，不能用近义词扩张分支。同一类不挂多条路径。合并后路径不同，在保留类的 class_updates.category_paths 中明确选一条主要路径；全目录整理为尚未组织的类补齐主要路径。

本批归类依据 items 描述与示例，目录整理依据 library 定义、边界、别名和代表样本。count/established_count/uncertain_count 仍是发现次数，不是独立回答支持数；使用 established_answer_ids 的并集判断新类支持。待观察保留原发现及理由，后续增加独立已确认样本再归类。疑似与已确认可归入同一现象类，保留各自状态。label、definition 和主题用完整名称说明问题；业务型号和错误码按原文保留。

assignments.item_id 填 O 编号；每条在 class_id、new_class_index、deferred_reason 中只填一个。new_class_index 是本次 new_classes 的零起始位置，多个观察可归入同一位置。class_id、closest_existing、merges.into/from、class_updates.class_id 填 C 编号。

通过 submit_evaluation 提交完整结果，按反馈修正后重新提交。
