按本工具的参数 Schema 直接提交完整原材料核查 JSON。checks 与 verification_check_slots 按原顺序一一对应，每格填写 result、source_evidence、observation。concerns 记录具体待核主张及证据；业务判断遵循当前核查指令。
accepted=true 后阅读返回的 material，完成最终评测，不再次调用本工具。accepted=false 时按 errors 修正完整核查 JSON。此工具与最终提交共用 content_call_limit，剩余次数见 budget.content_remaining。
