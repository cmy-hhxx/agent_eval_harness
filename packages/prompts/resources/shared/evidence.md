引用材料或读取工具返回的 reference，例如 `{evidence_index: 3}`。reference.evidence_index 是本任务从1开始的证据编号。读完对应原文、条件和例外后，选择能支持结论的编号。
图片先查看，reference.observation 写实际看到的内容。反馈给出 read_request 时，先按参数读取，再使用返回的 reference。
