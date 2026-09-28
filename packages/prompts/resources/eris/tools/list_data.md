查询共享只读评测数据目录。省略 runId 列出运行；提供 runId 分页查询输入和任务业务引用。

返回 kind、分页单位、hasMore、nextOffset；默认 30 条、最多 100 条。输入项的 reference 用于读取原始消息，任务项的 reference 用于读取正式结果，可直接传给 read_data。
