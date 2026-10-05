提交当前工作目录内已有的原材料核查 JSON 文件，仅传相对 path；文件正文遵循描述附带的 file_content_schema。checks 与 verification_check_slots 按原顺序一一对应，每格填写 result、source_evidence、observation。concerns 记录具体待核主张及证据；业务判断遵循当前核查指令。收到拒绝反馈后先成功写入修正内容，再提交文件。
accepted=true 后阅读返回的 material，完成最终评测，不再次调用本工具。accepted=false 时按 errors 修正完整核查 JSON。此工具与最终提交共用 content_call_limit，剩余次数见 budget.content_remaining。
