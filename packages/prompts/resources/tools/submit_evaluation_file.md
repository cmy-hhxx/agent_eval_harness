先在当前工作目录写入符合 file_content_schema 的 JSON 文件。用 edit_json 写稿时，成功回执即确认保存；用 execute_code 写稿时，在 outputs 声明同一相对文件名，exit_code=0 且无 errors 即确认产物读取成功。无需为确认刚写的内容再调用 read_artifact；提交只传 path，例如 evaluation-draft.json。
内容拒绝后按反馈修改文件，成功写入再提交。路径或读取失败时修正对应问题，文件加载错误最多三次。内容提交共用修正预算，剩余额度以工具反馈为准。
