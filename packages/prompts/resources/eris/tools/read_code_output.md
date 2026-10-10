分页读取本会话 execute_code 的脚本、stdout、stderr 或文件产物。id 原样使用 artifacts[].id。

offset / limit 按 UTF-16 字符计，按 hasMore / nextOffset 续读；文本窗口可能不是完整文件或 JSON。这里只读取已保存产物，不重新执行代码。
