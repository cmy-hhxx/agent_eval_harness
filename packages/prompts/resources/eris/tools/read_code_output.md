分页读取本会话 execute_code 返回的文本产物，包括脚本、stdout、stderr 和 outputs 声明的文件。id 必须原样取 artifacts[].id，不是文件名、路径或另一个会话的 ID。

示例：read_code_output({id:artifacts中对应项的id,offset:4000,limit:8000})。offset 从0开始，limit 默认8000、最多16000个 UTF-16 字符。根据 hasMore / nextOffset 续读；不需要全文时，只读决定判断的部分。此工具只读取产物，不重新执行代码；文本窗口不是完整文件时，不直接当成完整 JSON 解析。
