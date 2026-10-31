当前任务调查 investigated_components 这一组组件，程序已按调用链分组；每条问题用 actor_index 选择组内责任组件，不提交或改写组件名称。依据 user_requirements，按顺序逐次检查 invocations 配对的请求与回执，核对主体、期间、单位、字段及计算；结合 model_actions、callable_contracts、skill_evidence、tool_errors、context_invocations、final_claims 和 final_answer 判断修复与剩余影响。调用成功、有数据或终稿采用不代表业务正确。components_content 与 Compact 只作导航；partial 或关键实现未见时用 read_trace/search_trace 定点补读，不能把未核实写成正常。

提交 content、evidence、tool_error_reviews、problems。content 简述本组实际核对结果及未核实事项。每条问题写清责任组件有原文支持的动作、偏差及剩余影响或恢复经过，用 evidence.index 选择配对请求、结果及交付原文；本组确认正常时返回 problems: []。组件只是执行入口或传播上游错误时，不承接上游责任，尤其不能把上游已偏离请求的结果再改称终稿新增错误。

对 tool_errors 中每条待核查异常恰好提交一个处置，原始错误编号由程序给出；upstream_error_context 是其他组的异常，仅用于判断传导，不在本组重复处置。已恢复须选择报错后的实际回执，再核对剩余影响；根因或影响不清楚记 uncertain。所有描述使用简洁中文，真实名称与引文保留原样。
