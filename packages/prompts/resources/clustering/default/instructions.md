先阅读 `items`、`library` 和 `budget`。O1、O2… 是观察编号，C1、C2… 是问题类编号，P1、P2… 是组件编号；引用观察或已有类时只使用本次材料给出的编号，`component` 填组件名称。

1. 每条 `item` 在 `assignments` 中恰好出现一次。先比较同一组件下已有类的定义、边界和别名；含义相同的不同说法归入已有 `class_id`，组件别名视作同一组件。不因确定程度不同另建类。检查本次涉及的近义类；`budget.consolidate=true` 时检查整个同组件目录。
2. 没有合适的已有类时，才考虑 `new_classes`。`component` 沿用观察所属组件的名称，已有组件优先用目录的 `label`；`label` 简短，`definition` 独立描述可复用的行为、触发范围和可见结果。同组件有已有类时，`closest_existing` 必须选择其中最接近的 C 编号，`novelty` 说明实质差异；没有已有类时省略 `closest_existing` 或填 `null`，`novelty` 说明此现象的边界。名称换词、同一缺陷的不同后果或同义描述不足以新建类。
3. 新增类数不超过 `budget.max_new_classes`；合并后的活跃类数加新增类数不超过 `budget.max_classes`。新增组件数与组件总数分别不超过 `budget.max_new_components` 和 `budget.max_components`。每个新类所覆盖观察的 `count` 之和至少为 `budget.min_support`，且至少覆盖一条观察。没有合适类且这些限制阻止新建时，填写 `deferred_reason` 说明具体限制；有合适类时不能延期，也不能为了完成归类硬塞进不匹配的类。
4. 同组件近义类用 `merges` 指定保留类 `into`、被合并类 `from` 和理由。`from` 中每个类只出现一次，不能包含自身的 `into`，也不能同时成为其他合并的 `into`；观察归入保留类。合并不提高 `max_new_classes`。已有类需要修正名称、定义或主题时，用 `class_updates` 指定 C 编号、修改字段和 `reason`，每类只维护一次；被合并的类不再作为归类或维护目标。
5. 新类或已有类的 `category_paths` 按现象组织，每类最多三条路径，每条最多三级，每级直接填写字符串，例如 `[["工具使用","工具输出误解"],["数值可靠性"]]`。层级名称为简洁的单行纯文本，不含 `< > [ ] { }`、换行或控制字符；不重复路径，也不在同一路径内重复层级。沿用有用的现有主题措辞，同一类可属于多个主题。合并后的路径超过三条时，在保留类的 `class_updates.category_paths` 中明确选择要保留的路径。

本批观察依据 `items` 的描述和示例；已有类的复用、合并和维护依据 `library` 的定义、边界与别名，不要求本批有对应观察才可整理已有类。`established_count`、`uncertain_count` 和示例的 `evidence_status` 表示观察的确定程度，归类不使待核实的问题变成已确认。类定义不能补出材料没有支持的成因、责任、禁令或必需输出结构，不凭类名或出现次数推断这些事实；不把单个样本的严重程度、核心是否可用或胜负写成整类性质。用户意图含糊、没有支持工具、正确执行护栏或权限限制本身不自动构成缺陷。

区分结果偏差和责任组件，不能凭最终结果或类名称更改观察的组件。引用问题须区分“无法定位来源”和“来源不支持主张”；工具调用次数或标号大小不能证明引用错误。字段或期间未对齐、内部不一致、缺少信息分别按观察中的实际描述归类，不扩成术语替换、故意省略或系统失败。`label`、`definition` 和主题须独立可理解，不使用本次 O/C/P 编号解释含义；真实业务型号和错误码按材料保留。

`assignments.item_id` 填 O 编号。每条 assignment 在 `class_id`、`new_class_index`、`deferred_reason` 中只填一个；`new_class_index` 是本次 `new_classes` 数组的位置，从 0 开始，多个观察可以选择同一位置。`class_id`、`closest_existing`、`merges.into/from` 和 `class_updates.class_id` 填 C 编号。通过 `submit_evaluation` 提交完整结果，按校验反馈修正后重新提交。
