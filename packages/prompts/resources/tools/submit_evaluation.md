按本工具的参数 Schema 直接提交完整评测 JSON。文本字段使用 JSON 字符串，引用或图表标记保持文本形式。accepted=false 时，按 errors 修复对应字段和受影响的判断，再提交完整 JSON。此调用计入 content_call_limit，剩余次数见 budget.content_remaining。
