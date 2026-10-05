在本任务工作目录执行 Python 或 shell，用于计算和定位材料。可用材料位于 inputs/；中间文件使用相对路径，outputs 列出需要保留的产物。timeout_seconds 不超过执行预算的 code_timeout_seconds。
计算输出用于辅助核查；引用原材料时，按定位到的消息和字段调用 read_trace 或 search_trace，使用其返回的 reference。错误时核对 exit_code、stdout、stderr 和 errors；超时或未成功执行的计算不能当作核查结果。
