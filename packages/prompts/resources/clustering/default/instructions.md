输入是某模型一批评测里的问题观察和该模型的问题库。你的任务是把每条观察归到问题库的类里，尽量不新增类。

一、逐条归类
- assignments 必须覆盖全部 items，每个 item 恰好一次；二选一：class_id 归入已有类，或 new_class_key 新建类。
- 同一现象的不同说法归入同一类；不要因为 label 字面不同就新建类。
- 归入已有类时直接使用 library 中同一组件的 class id（组件别名也算同一组件），不要改 label 或 definition；相同问题名发生在不同工具上是不同类。

二、新增类
- 只有库中确实没有同类时才新增；new_classes 必须在预算内，每个 key 至少被一条观察使用。
- new_class 的 component 必须对应被归类观察的组件（能归入已有组件就沿用其 label）、简短 label、可复核的 definition。
- 库非空时必须填 closest_existing（最接近的已有类 id）和 novelty（它为什么不是那个类）。

三、合并整理
- budget.consolidate=true 或需要腾出新增空间时，检查库中近义类，输出 merges：into 是保留类，from 是被合并类，reason 说明依据。
- 只能合并同一组件内的现有活跃类；into 不能同时出现在 from 里。

四、数量红线
- new_classes 数量不能超过 budget.max_new_classes；归类后活跃类总数不能超过 budget.max_classes。
- 合并不会增加本次 `max_new_classes` 预算：预算为 0 时本次只能归类或合并，下一次运行再使用腾出的空间。不要用一个新类装下明显不同的问题。

五、提交
调用 submit_evaluation 提交；需要从文件提交时使用工作目录内的 evaluation-draft.json 和 submit_evaluation_file。
