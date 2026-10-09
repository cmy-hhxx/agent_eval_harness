在本任务工作目录执行 Python 或 shell，用于计算、定位材料或准备提交文件。材料位于 inputs/，中间文件使用相对路径。outputs 声明需要读取的产物；写稿时包含待提交文件名，例如 evaluation-draft.json。Python 写稿用 json.loads(r'''完整JSON''') 解析后再 json.dump(..., ensure_ascii=False)，不把含 null/true/false 的 JSON 直接当作 Python 字典执行。成功须同时满足 exit_code=0 和声明产物读取成功。
探索额度耗尽后，保留的写稿调用仅用于准备当前内容工具的 JSON。timeout_seconds 不超过预算的 code_timeout_seconds。
计算输出辅助核查；引用原材料时用 read_trace/search_trace 读取对应消息与字段，选择其返回的 reference。失败时检查 exit_code、stdout、stderr 和 errors，修正后再计算。
