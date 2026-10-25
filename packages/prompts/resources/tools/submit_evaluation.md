按本工具的参数 Schema 直接提交完整评测 JSON。文本字段使用 JSON 字符串，引用或图表标记保持文本形式。accepted=false 时，按 errors 修复对应字段和受影响的判断，再提交完整 JSON。此调用计入 content_call_limit，剩余次数见 budget.content_remaining。
只提交本工具 Schema 允许的判断字段，禁止额外字段。candidate 是读取工具的定位参数，不是顶层提交字段；不得添加 /candidate。若该字段被退回，删除 /candidate，保留其余判断字段和证据编号后重新提交，不重新调查或重写全部判断。
