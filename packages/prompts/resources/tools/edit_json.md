直接增量编辑工作目录内的 JSON 对象文件，不执行代码、不判断内容。path 为单个 .json 文件名；不存在时从空对象开始。

set_json 是 JSON 对象字符串，替换其中列出的顶层字段；append_json 是 JSON 对象字符串，将其中数组逐行追加到同名数组，未指定字段保持原样。remove_fields 删除列出的顶层字段。set_pointer/value_json 按 JSON Pointer（如 /Problem/0/reason）只改一个嵌套字段，remove_pointer 删除一个嵌套字段或数组元素；以上按顺序执行，语法、路径或数组下标错误时原文件不变。已有问题优先追加，修正已有行时才替换该数组；不要为了补顶层结论重写已确认问题。

返回实际文件名、更新字段和所有数组的行数，不重复整份正文。直接使用 JSON 的 null/true/false，数字、日期与证据编号按原文写入。调查短笔记可暂存在草稿内，提交前移除非正文 Schema 字段，再用 submit_evaluation_file 提交同一文件。写稿与其他探索工具共用现有预算；计算仍用 execute_code。
