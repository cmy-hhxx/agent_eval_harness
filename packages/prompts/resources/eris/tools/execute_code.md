编写并执行 Python 或 Bash 脚本，自主核对公式、统计、分组、抽样、文本处理与反例。可使用 Python 标准库（json、decimal、statistics、math、csv、unittest 等）；精确金额使用 decimal。代码核验输出是计算结果，不是新增外部证据或正式判决。

完整调用示例：execute_code({language:"python",code:"from decimal import Decimal\nvalues = [Decimal('0.1'), Decimal('0.2')]\nassert sum(values) == Decimal('0.3')\nprint(sum(values))"})。必填 language 和 code；timeout_seconds 可省略，最长60秒。输出给出 exit_code、timed_out、cancelled、stdout、stderr 和 artifacts；异常看 stderr 后修正，退出码非0不能声称校验通过。

同一会话复用独立工作目录，相对路径均以它为基准；脚本可读写计算中间文件。outputs 可列要保留的相对文件名。stdout/stderr 各只展示前4000字符，完整输出在 artifacts 中，按 name 找到 stdout/stderr 对应项，再用 read_code_output({id:该项.id}) 分页读取，不要反复执行只为翻页。

从已读材料选择必要字段写进代码，注明实际输入和假设。先在代码内筛选、聚合、断言，只打印结论、计数和有代表性的异常；不要输出整个数据集。工具不注入网关密钥。保持原始数据与正式结果不变；联网取证优先使用 search_web/read_web 以保留来源。
