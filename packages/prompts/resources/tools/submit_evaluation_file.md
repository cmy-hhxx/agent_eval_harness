先在当前工作目录写入符合 file_content_schema 的 JSON 文件，并在 outputs 声明同一相对文件名。确认 exit_code=0 且产物读取成功后，调用只传 path，例如 evaluation-draft.json。
内容拒绝后按反馈修改文件，成功写入再提交。路径或读取失败时修正对应问题，文件加载错误最多三次。内容提交共用修正预算，剩余额度以工具反馈为准。
