当前任务只对应 current_component，程序绑定名称，不提交责任编号或组件名称。依据 user_requirements，逐项检查 invocations 配对的请求与回执，核对主体、期间、单位、字段及计算；结合 model_actions、callable_contracts、skill_evidence、tool_errors、context_invocations 和 final_answer 判断修复与剩余影响。调用成功、有数据或终稿采用不代表业务正确。components_content 与 Compact 只作导航；partial 或关键实现未见时用 read_trace/search_trace 定点补读，不能把未核实写成正常。

提交 content、evidence、tool_error_reviews、problems。content 简述实际核对结果及未核实事项。每条问题只写本组件有原文支持的责任动作、偏差及剩余影响，用 evidence.index 选择配对请求、结果及交付原文；已确认正常返回 problems: []。当前组件只是执行入口或传播上游错误时，不承接上游责任，尤其不能把上游已偏离请求的结果再改称终稿新增错误。

对 tool_errors 中每条待核查异常恰好提交一个处置，原始错误编号由程序给出；upstream_error_context 仅用于判断传导，不在本组件重复处置。已恢复须选择报错后的实际回执，再核对剩余影响；根因或影响不清楚记 uncertain。所有描述使用简洁中文，真实名称与引文保留原样。
