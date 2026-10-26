分页查看程序保存的真实执行图，不读取证据正文。candidate 选择材料；view=nodes 按 query、message_index 定位真实调用，view=boundaries 按 execution_node_index 找相关证据边界，或按已提供的 evidence_index 反查该证据的真实关联边界（matched_sides 标明所属侧，不代表责任判定），kind 可限定请求形成、执行、传递、生成或交付类型。view=before/after 按 transition_index 查看该边界两侧的证据编号和 read_trace/view_image 入口，可用 message_index、精确 path 限定所需来源；view=predecessors/successors 查看一层前后关联，不递归展开。view=table_checks 分页查看当前表格核验疑点，按其证据入口读取原文。

offset、limit、max_chars 控制结构页，按 next_request.arguments 继续，入口的 tool 指定应调用的工具。每页给 total、next_offset、has_more 和返回字符数。调用节点、边界编号、证据编号不同；历史输入中的来源引用不是新执行。读取入口表示材料可读，不表示原文已读或内容正确；正文按精确路径和范围用 read_trace 读取，相关图片用 view_image。已有完整原文可复用；只追查能区分当前疑点成因的分支。不得将未展开或未读记录称为未采集。

节点页的 responsibility_choices 直接给出该次调用可选的责任编号及中文动作；边界页同时显示 component、message_index 和 action。已取得编号就直接使用，不必仅为查编号再消耗一次调用；主体未采集与尚未查询编号是两回事。

read_trace 同时返回所读原始调用的 responsibility_choices；最终正文调用也在初始 final_generation_choices 中，观察到的材料变化边界在 context_transfer_choices 中。组件名称按健康度报表展示，具体动作单独解释；同名组件的不同 transition_index 仍是不同调用，不按名称合并。上下文组装与传递只在材料确实缺失、截断或改写时可选，正常传递不是责任主体。
